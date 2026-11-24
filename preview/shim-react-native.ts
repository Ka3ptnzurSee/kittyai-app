// react-native-web + die zwei Native-Registry-Exporte, die react-native-svg erwartet.
export * from "react-native-web";
export const TurboModuleRegistry = { get: (): unknown => null, getEnforcing: (): unknown => null };
export const NativeModules = {};
