/**
 * Plugin System Entry Point
 * 
 * The plugin registry manages frontend plugin components.
 * Backend plugins are discovered and loaded by the Python PluginLoader.
 */

export { pluginRegistry } from './registry';
export type { PluginRegistration, PluginViewConfig, PluginSettingsConfig } from './registry';
