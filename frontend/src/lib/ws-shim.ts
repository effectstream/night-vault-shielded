// isomorphic-ws' browser entry default-exports the global WebSocket but does
// not provide a named `WebSocket` export, which the indexer provider imports.
// Alias isomorphic-ws to this shim so both import styles resolve at runtime.
const WS = globalThis.WebSocket;
export default WS;
export { WS as WebSocket };
