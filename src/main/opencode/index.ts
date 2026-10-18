// Component B entry: wire a connector over the provisional HTTP transport.
import { HttpOpenCodeTransport, type OpenCodeConfig } from './transport'
import { OpenCodeConnector, type ConnectorSinks, type ConnectorOptions } from './connector'

export function createOpenCodeConnector(
  cfg: OpenCodeConfig,
  sinks: ConnectorSinks,
  opts?: ConnectorOptions
): OpenCodeConnector {
  return new OpenCodeConnector(new HttpOpenCodeTransport(cfg), sinks, opts)
}

export { OpenCodeConnector } from './connector'
export type { OpenCodeTransport, OpenCodeConfig, RawEvent } from './transport'
export type { ConnectorSinks } from './connector'
export { normalize } from './normalize'
export { mergeConfig, isPlainObject, type JsonObject } from './configMerge'
