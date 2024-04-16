const { dirname, join } = require("path");
const Registry = require("winreg");
const koffi = require("koffi");

const { VoicemeeterDefaultConfig, VoicemeeterType, RunVoicemeeterType, InterfaceType, LevelType, DeviceType, MacroButtonState, MacroButtonTrigger, MacroButtonColor } = require("./voicemeeterEnums");

const getDLLPath = () => {
    const regKey = new Registry({
        hive: Registry.HKLM,
        key: "\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\VB:Voicemeeter {17359A74-1236-5467}"
    });
    return new Promise((resolve) => {
        regKey.values((error, items) => {
            if (error) throw new Error("could not read voicemeeter dll path from registry");
            const uninstallerPath = items.find((item) => item.name === "UninstallString").value;
            resolve(join(dirname(uninstallerPath), "VoicemeeterRemote64.dll"));
        });
    });
}

let libvoicemeeter;

const voicemeeter = {
    VoicemeeterType,
    RunVoicemeeterType,
    InterfaceType,
    LevelType,
    DeviceType,
    MacroButtonState,
    MacroButtonTrigger,
    MacroButtonColor,
    _libvoicemeeter: null,

    // reflecting the dll initialization state
    isInitialised: false,
    // reclecting a connection to the vm api
    isConnected: false,
    // reflecting a previous connection to the vm api for auto re-connecting. resets on logout.
    hadConnection: false,

    outputDevices: [],
    inputDevices: [],
    type: 0,
    version: null,
    voicemeeterConfig: null,

    async init() {
        const dll = koffi.load(await getDLLPath());

        this._libvoicemeeter = libvoicemeeter = {
            // expose dll and koffi in case the user want to use it directly
            _dll: dll,
            _koffi: koffi,

            // Login
            VBVMR_Login: dll.func("long __stdcall VBVMR_Login(void)"),
            VBVMR_Logout: dll.func("long __stdcall VBVMR_Logout(void)"),
            VBVMR_RunVoicemeeter: dll.func("long __stdcall VBVMR_RunVoicemeeter(long vType)"),

            // General informations
            VBVMR_GetVoicemeeterType: dll.func("long __stdcall VBVMR_GetVoicemeeterType(_Out_ long * pType)"),
            VBVMR_GetVoicemeeterVersion: dll.func("long __stdcall VBVMR_GetVoicemeeterVersion(_Out_ long * pVersion)"),

            // Get parameters
            VBVMR_IsParametersDirty: dll.func("long __stdcall VBVMR_IsParametersDirty(void)"),
            VBVMR_GetParameterFloat: dll.func("long __stdcall VBVMR_GetParameterFloat(char * szParamName, _Out_ float * pValue)"),
            VBVMR_GetParameterStringA: dll.func("long __stdcall VBVMR_GetParameterStringA(char * szParamName, _Out_ void * szString)"),
            VBVMR_GetParameterStringW: dll.func("long __stdcall VBVMR_GetParameterStringW(char * szParamName, _Out_ unsigned short * wszString)"),

            // Get levels
            VBVMR_GetLevel: dll.func("long __stdcall VBVMR_GetLevel(long nType, long nuChannel, _Out_ float * pValue)"),
            VBVMR_GetMidiMessage: dll.func("long __stdcall VBVMR_GetMidiMessage(_Out_ unsigned char *pMIDIBuffer, long nbByteMax)"),
            VBVMR_SendMidiMessage: dll.func("long __stdcall VBVMR_SendMidiMessage(_Out_ unsigned char *pMIDIBuffer, long nbByte)"),

            // Set parameters
            VBVMR_SetParameterFloat: dll.func("long __stdcall VBVMR_SetParameterFloat(char * szParamName, float Value)"),
            VBVMR_SetParameterStringA: dll.func("long __stdcall VBVMR_SetParameterStringA(char * szParamName, char * szString)"),
            VBVMR_SetParameterStringW: dll.func("long __stdcall VBVMR_SetParameterStringW(char * szParamName, unsigned short * wszString)"),
            VBVMR_SetParameters: dll.func("long __stdcall VBVMR_SetParameters(char * szParamScript)"),
            VBVMR_SetParametersW: dll.func("long __stdcall VBVMR_SetParametersW(unsigned short * szParamScript)"),

            // Devices enumerator
            VBVMR_Output_GetDeviceNumber: dll.func("long __stdcall VBVMR_Output_GetDeviceNumber(void)"),
            VBVMR_Output_GetDeviceDescA: dll.func("long __stdcall VBVMR_Output_GetDeviceDescA(long zindex, _Out_ long * nType, _Out_ void * szDeviceName, _Out_ void * szHardwareId)"),
            VBVMR_Output_GetDeviceDescW: dll.func("long __stdcall VBVMR_Output_GetDeviceDescW(long zindex, _Out_ long * nType, _Out_ unsigned short * wszDeviceName, _Out_ unsigned short * wszHardwareId)"),
            VBVMR_Input_GetDeviceNumber: dll.func("long __stdcall VBVMR_Input_GetDeviceNumber(void)"),
            VBVMR_Input_GetDeviceDescA: dll.func("long __stdcall VBVMR_Input_GetDeviceDescA(long zindex, _Out_ long * nType, _Out_ void * szDeviceName, _Out_ void * szHardwareId)"),
            VBVMR_Input_GetDeviceDescW: dll.func("long __stdcall VBVMR_Input_GetDeviceDescW(long zindex, _Out_ long * nType, _Out_ unsigned short * wszDeviceName, _Out_ unsigned short * wszHardwareId)"),

            // TODO Implement callback

            // Macro buttons
            VBVMR_MacroButton_IsDirty: dll.func("long __stdcall VBVMR_MacroButton_IsDirty(void)"),
            VBVMR_MacroButton_GetStatus: dll.func("long __stdcall VBVMR_MacroButton_GetStatus(long nuLogicalButton, _Out_ float * pValue, long bitmode)"),
            VBVMR_MacroButton_SetStatus: dll.func("long __stdcall VBVMR_MacroButton_SetStatus(long nuLogicalButton, float fValue, long bitmode)")
        };

        this.isInitialised = true;
    },

    checkConnection() {
        if (this.hadConnection && !this.isConnected) {
            // throwing this would be annoying af
            //throw "Connection lost";

            // reset connection state
            try {
                this.login();
            } catch (e) {
                // throw connection lost in case the login throws "Login failed"
                if (e === "Login failed")
                    throw "Login not recoverable";
                throw e;
            }
        }

        if (!this.isInitialised)
            throw "Not initialised. await voicemeeter.init() first.";

        if (!this.isConnected)
            throw "Not connected. voicemeeter.login() first.";
    },

    runVoicemeeter(runVoicemeeterType) {
        if (libvoicemeeter.VBVMR_RunVoicemeeter(runVoicemeeterType) !== 0)
            throw "Running failed";
    },

    isParametersDirty() {
        this.checkConnection();

        const retval = libvoicemeeter.VBVMR_IsParametersDirty();
        switch (retval) {
            case 0: {
                return false;
            }
            case 1: {
                return true;
            }
            case -2: {
                // api got disconnected
                this.isConnected = false;
                // re-run this function to re-connect. will throw if not possible.
                return voicemeeter.isParametersDirty();
            }

            default: {
                console.error("unknown return value", retval);
                throw "Running failed";
            }
        }
    },

    /**
     * @deprecated Use getRawParameterFloat 
     */
    getParameter(parameterName) {
        return getRawParameterFloat(parameterName);
    },

    getRawParameterFloat(parameter) {
        this.checkConnection();

        const value = [0];
        const retval = libvoicemeeter.VBVMR_GetParameterFloat(parameter, value);
        switch (retval) {
            case 0: {
                return value[0];
            }
            case -1: {
                // invalid type. likely a string then.
                return voicemeeter.getRawParameterString(parameter);
            }
            case -2: {
                // api got disconnected
                this.isConnected = false;
                // re-run this function to re-connect. will throw if not possible.
                return voicemeeter.getRawParameterFloat(parameter);
            }
            case -3: {
                // out of range exception
                throw "Parameter out of range";
            }

            default: {
                console.error("unknown return value", retval);
                throw "Running failed";
            }
        }
    },

    getRawParameterString(parameter) {
        this.checkConnection();

        const buffer = Buffer.allocUnsafe(4096);
        const retval = libvoicemeeter.VBVMR_GetParameterStringW(parameter, buffer);
        
        switch (retval) {
            case 0: {
                return koffi.decode(buffer, "char16_t", 2048);
            }
            case -1: {
                // invalid type. likely write-only then.
                return undefined;
            }
            case -2: {
                // api got disconnected
                this.isConnected = false;
                // re-run this function to re-connect. will throw if not possible.
                return voicemeeter.getRawParameterString(parameter);
            }

            default: {
                console.error("unknown return value", retval);
                throw "Running failed";
            }
        }
    },

    setRawParameterFloat(parameter, value) {
        this.checkConnection();

        const retval = libvoicemeeter.VBVMR_SetParameterFloat(parameter, value);
        switch (retval) {
            case 0: {
                return;
            }
            case -1: {
                // invalid type.
                throw "Invalid type";
            }
            case -2: {
                // api got disconnected
                this.isConnected = false;
                // re-run this function to re-connect. will throw if not possible.
                return voicemeeter.setRawParameterFloat(parameter, value);
            }

            default: {
                console.error("unknown return value", retval);
                throw "Running failed";
            }
        }
    },

    setRawParameterString(parameter, value) {
        this.checkConnection();

        const buffer = Buffer.allocUnsafe(4096);
        koffi.encode(buffer, "char16_t", value, Math.min(value.length +1, 2048));
        const retval = libvoicemeeter.VBVMR_SetParameterStringW(parameter, buffer);
        switch (retval) {
            case 0: {
                return;
            }
            case -1: {
                // invalid type.
                throw "Invalid type";
            }
            case -2: {
                // api got disconnected
                this.isConnected = false;
                // re-run this function to re-connect. will throw if not possible.
                return voicemeeter.setRawParameterString(parameter, value);
            }

            default: {
                console.error("unknown return value", retval);
                throw "Running failed";
            }
        }
    },

    setRawParameters(value) {
        this.checkConnection();

        const buffer = Buffer.allocUnsafe(4096);
        koffi.encode(buffer, "char16_t", value, Math.min(value.length +1, 2048));
        const retval = libvoicemeeter.VBVMR_SetParametersW(buffer);
        switch (retval) {
            case 0: {
                return;
            }
            case -1: {
                // invalid type.
                throw "Invalid type";
            }
            case -2: {
                // api got disconnected
                this.isConnected = false;
                // re-run this function to re-connect. will throw if not possible.
                return voicemeeter.setRawParameters(value);
            }

            default: {
                console.error("unknown return value", retval);
                throw "Running failed";
            }
        }
    },

    login() {
        if (!this.isInitialised)
            throw "Await the initialization before login";

        if (this.isConnected)
            throw "Already connected";

        if (libvoicemeeter.VBVMR_Login() !== 0)
            throw "Login failed";

        this.type = this._getVoicemeeterType();
        this.version = this._getVoicemeeterVersion();
        this.voicemeeterConfig = VoicemeeterDefaultConfig[this.type];
        this.isConnected = true;
        this.hadConnection = true;
    },

    logout() {
        // silently logout in case we are not connected.
        if (!this.isConnected) {
            this.hadConnection = false;
            return;
        }

        this.isConnected = false;
        this.hadConnection = false;

        libvoicemeeter.VBVMR_Logout();
    },

    getOutputDeviceNumber() {
        return libvoicemeeter.VBVMR_Output_GetDeviceNumber();
    },

    getInputDeviceNumber() {
        return libvoicemeeter.VBVMR_Input_GetDeviceNumber();
    },

    updateDeviceList() {
        this.checkConnection();

        this.outputDevices = [];
        this.inputDevices = [];

        ["Output", "Input"].forEach((type) => {
            const container = this[`${type.toLowerCase()}Devices`];
            const deviceNumber = this[`get${type}DeviceNumber`]();

            for (let i = 0; i < deviceNumber; i++) {
                const deviceType = [0];
                const deviceNameBuffer = Buffer.allocUnsafe(4096);
                const hardwareIdBuffer = Buffer.allocUnsafe(4096);

                if (libvoicemeeter[`VBVMR_${type}_GetDeviceDescW`](i, deviceType, deviceNameBuffer, hardwareIdBuffer) !== 0)
                    throw `reading ${type} devices failed`;

                const name = koffi.decode(deviceNameBuffer, "char16_t", 2048);
                const hardwareId = koffi.decode(hardwareIdBuffer, "char16_t", 2048);

                container.push({
                    type: deviceType[0],
                    name,
                    hardwareId,
                });
            }
        });
    },

    showVoicemeeter() {
        this.setRawParameters("Command.Show=1;");
    },
    
    hideVoicemeeter() {
        this.setRawParameters("Command.Show=0;");
    },

    shutdownVoicemeeter() {
        this.setRawParameters("Command.Shutdown=1;");
    },

    restartVoicemeeterAudioEngine() {
        this.setRawParameters("Command.Restart=1;");
    },

    ejectVoicemeeterCassette() {
        this.setRawParameters("Command.Eject=1;");
    },

    resetVoicemeeterConfiguration() {
        this.setRawParameters("Command.Reset=1;");
    },

    saveVoicemeeterConfiguration(filename) {
        this.setRawParameters("Command.Save=" + filename + ";");
    },

    loadVoicemeeterConfiguration(filename) {
        this.setRawParameters("Command.Load=" + filename + ";");
    },

    lockVoicemeeterGui(lock) {
        this.setRawParameters("Command.Lock=" + (lock ? 1 : 0) + ";");
    },

    setMacroButtonState(button, state) {
        if (!Object.values(MacroButtonState).includes(state))
            throw "Invalid state";
        this.setRawParameters("Command.Button[" + button + "].State=" + state + ";");
    },

    setMacroButtonStateOnly(button, state) {
        if (!Object.values(MacroButtonState).includes(state))
            throw "Invalid state";
        this.setRawParameters("Command.Button[" + button + "].StateOnly=" + state + ";");
    },

    setMacroButtonTrigger(button, trigger) {
        if (!Object.values(MacroButtonTrigger).includes(trigger))
            throw "Invalid trigger";
        this.setRawParameters("Command.Button[" + button + "].Trigger=" + trigger + ";");
    },

    /**
     * Seems to be broken in the Voicemeeter API
     */
    setMacroButtonColor(button, color) {
        if (!Object.values(MacroButtonColor).includes(color))
            throw "Invalid color";
        this.setRawParameters("Command.Button[" + button + "].Color=" + color + ";");
    },

    showVbanChatDialog() {
        this.setRawParameters("Command.DialogShow.VBANCHAT=1;");
    },

    getLevel(type, channel) {
        this.checkConnection();

        const value = [0];
        if (libvoicemeeter.VBVMR_GetLevel(type, channel, value) !== 0)
            throw "Running failed";

        return value[0];
    },

    _getVoicemeeterType() {
        const voicemeeterType = [0];
        if (libvoicemeeter.VBVMR_GetVoicemeeterType(voicemeeterType) !== 0)
            throw "Running failed";

        switch (voicemeeterType[0]) {
            case 1:
                return VoicemeeterType.voicemeeter;
            case 2:
                return VoicemeeterType.voicemeeterBanana;
            case 3:
                return VoicemeeterType.voicemeeterPotato;
            default:
                return VoicemeeterType.unknown;
        }
    },

    _getVoicemeeterVersion() {
        const voicemeeterVersion = [0];
        if (libvoicemeeter.VBVMR_GetVoicemeeterVersion(voicemeeterVersion) !== 0)
            throw "Running failed";

        const v1 = (voicemeeterVersion[0] & 0xFF000000) >> 24;
        const v2 = (voicemeeterVersion[0] & 0x00FF0000) >> 16;
        const v3 = (voicemeeterVersion[0] & 0x0000FF00) >> 8;
        const v4 = voicemeeterVersion[0] & 0x000000FF;

        return `${v1}.${v2}.${v3}.${v4}`;
    },

    _getParameterFloat(type, name, id) {
        this.checkConnection();

        if (!this.voicemeeterConfig)
            throw "Configuration error";

        if (!Object.values(InterfaceType).includes(type))
            throw "Invalid type";

        const interfaceType = type === InterfaceType.strip ? "Strip" : "Bus";

        if (!this.voicemeeterConfig[type === InterfaceType.strip ? "strips" : "buses"].some((strip) => strip.id === id))
            throw `${interfaceType} ${id} not found`;

        const parameter = `${interfaceType}[${id}].${name}`;

        return this.getRawParameterFloat(parameter);
    },

    _getParameterString(type, name, id) {
        this.checkConnection();

        if (!this.voicemeeterConfig)
            throw "Configuration error";

        if (!Object.values(InterfaceType).includes(type))
            throw "Invalid type";

        const interfaceType = type === InterfaceType.strip ? "Strip" : "Bus";

        if (!this.voicemeeterConfig[type === InterfaceType.strip ? "strips" : "buses"].some((strip) => strip.id === id))
            throw `${interfaceType} ${id} not found`;

        const parameter = `${interfaceType}[${id}].${name}`;

        return this.getRawParameterString(parameter);
    },

    _setParameterFloat(type, name, id, value) {
        this.checkConnection();

        if (!this.voicemeeterConfig)
            throw "Configuration error";

        if (!Object.values(InterfaceType).includes(type))
            throw "Invalid type";

        const interfaceType = type === InterfaceType.strip ? "Strip" : "Bus";

        if (!this.voicemeeterConfig[type === InterfaceType.strip ? "strips" : "buses"].some((strip) => strip.id === id))
            throw `${interfaceType} ${id} not found`;

        const parameter = `${interfaceType}[${id}].${name}`;

        this.setRawParameterFloat(parameter, value);
    },

    _setParameterString(type, name, id, value) {
        this.checkConnection();

        if (!this.voicemeeterConfig)
            throw "Configuration error";

        if (!Object.values(InterfaceType).includes(type))
            throw "Invalid type";

        const interfaceType = type === InterfaceType.strip ? "Strip" : "Bus";

        if (!this.voicemeeterConfig[type === InterfaceType.strip ? "strips" : "buses"].some((strip) => strip.id === id))
            throw `${interfaceType} ${id} not found`;

        const parameter = `${interfaceType}[${id}].${name}`;

        this.setRawParameterString(parameter, value);
    },

    _setParameters(parameters) {
        this.checkConnection();

        if (!this.voicemeeterConfig)
            throw "Configuration error";

        if (!Array.isArray(parameters))
            throw "Parameters must be an array";

        const script = parameters.map((parameter) => {

            if (!Object.values(InterfaceType).includes(parameter.type))
                throw "Invalid type";

            const interfaceType = parameter.type === InterfaceType.strip ? "Strip" : "Bus";

            if (!this.voicemeeterConfig[parameter.type === InterfaceType.strip ? "strips" : "buses"].some((strip) => strip.id === parameter.id))
                throw `${interfaceType} ${parameter.id} not found`;

            return `${interfaceType}[${parameter.id}].${parameter.name}=${parameter.value};`;

        }).join("");

        this.setRawParameters(script);
    },

    /**
     * @deprecated Use setRawParameters
     */
    _sendRawParameterScript(script) {
        this.setRawParameters(script);
    },
    
    api: new Proxy({}, {
        get(target, prop) {
            // resolve false promises
            if (prop === "then") return undefined;

            // if the property ends with " as string", return it as a string
            // example: console.log(api["vban.instream[0].name as string"]);
            if (prop.endsWith(" as string")) {
                return voicemeeter.getRawParameterString(prop.slice(0, -10));
            }

            // otherwise return it as float
            // example console.log(api["Bus[0].Gain"]);
            return voicemeeter.getRawParameterFloat(prop);
        },

        set(target, prop, value) {
            // convert boolean to numbers
            if (typeof value === "boolean") value = value ? 1 : 0;
            // send the value as float if it is a number, otherwise as string
            const action = typeof value === "number" ? "setRawParameterFloat" : "setRawParameterString";
            // examples
            // api["Bus[0].Gain"] = 0.5;
            // api["Bus[0].Device.wdm"] = "Totally Amazing Soundbar 2000";
            // api["Bus[0].FadeTo"] = "(-30, 200)";
            return voicemeeter[action](prop, value);
        },
    }),

}

const busParameterMappings = {
    "Delay": "Option.delay[$1]",
    "DeviceName": "Bus[$1].device.name",
    "DeviceSr": "Bus[$1].device.sr",
    "DeviceWdm": "Bus[$1].device.wdm",
    "DeviceMme": "Bus[$1].device.mme",
    "DeviceAsio": "Bus[$1].device.asio",
};

[
    "Mono",
    "Mute",
    "Gain",
    "ReturnReverb",
    "ReturnDelay",
    "ReturnFx1",
    "ReturnFx2",
    "Sel",
    "Monitor",
    "Label",
    "FadeTo",
    "FadeBy",
].forEach(name => busParameterMappings[name] = "Bus[$1]." + name);

const stripParameterMappings = {
    "CompGain": "Strip[$1].Comp.Gain",
    "CompRatio": "Strip[$1].Comp.Ratio",
    "CompThreshold": "Strip[$1].Comp.Threshold",
    "CompAttack": "Strip[$1].Comp.Attack",
    "CompRelease": "Strip[$1].Comp.Release",
    "CompKnee": "Strip[$1].Comp.Knee",
    "CompGainOut": "Strip[$1].Comp.GainOut",
    "CompMakeUp": "Strip[$1].Comp.MakeUp",
    "GateThreshold": "Strip[$1].Gate.Threshold",
    "GateDamping": "Strip[$1].Gate.Damping",
    "GateBPSidechain": "Strip[$1].Gate.BPSidechain",
    "GateAttack": "Strip[$1].Gate.Attack",
    "GateHold": "Strip[$1].Gate.Hold",
    "GateRelease": "Strip[$1].Gate.Release",
    "DenoiserThreshold": "Strip[$1].Denoiser.Threshold",
    "PitchOn": "Strip[$1].Pitch.On",
    "PitchDryWet": "Strip[$1].Pitch.DryWet",
    "PitchValue": "Strip[$1].Pitch.PitchValue",
    "PitchLoFormat": "Strip[$1].Pitch.LoFormat",
    "PitchMedFormat": "Strip[$1].Pitch.MedFormat",
    "PitchHiFormat": "Strip[$1].Pitch.HiFormat",
    "PitchRecallPreset": "Strip[$1].Pitch.RecallPreset",
};

[
    "Mono",
    "Mute",
    "Solo",
    "MC",
    "Karaoke",
    "Gain",
    "Pan_x",
    "Pan_y",
    "Color_x",
    "Color_y",
    "fx_x",
    "fx_y",
    "Audibility",
    "Gate",
    "Comp",
    "A1",
    "A2",
    "A3",
    "A4",
    "A5",
    "B1",
    "B2",
    "B3",
    "Denoiser",
    "PostReverb",
    "PostDelay",
    "PostFx1",
    "PostFx2",
    "FadeTo",
    "FadeBy",
    "Label",
    "Limit",
    "AppGain",
    "AppMute"
].forEach(name => stripParameterMappings[name] = "Strip[$1]." + name);

["Bus", "Strip"].forEach(type => {
    const isBus = type === "Bus";

    Object.entries(isBus ? busParameterMappings : stripParameterMappings).forEach(([name, mapping]) => {
        voicemeeter[`set${type}${name}`] = (number, value) => {
            if (typeof value === "boolean") value = value ? 1 : 0;
            const action = typeof value === "number" ? "setRawParameterFloat" : "setRawParameterString";
            voicemeeter[action](mapping.replace("$1", number), value);
        }

        voicemeeter[`get${type}${name}`] = (number) => {
            return voicemeeter.getRawParameterFloat(mapping.replace("$1", number));
        }
    });
});

module.exports = voicemeeter;
