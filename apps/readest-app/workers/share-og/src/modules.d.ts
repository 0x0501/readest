// Wrangler compiles `.wasm` imports into WebAssembly modules and, per the
// `[[rules]]` entry in wrangler.toml, `.ttf` imports into raw bytes.
declare module '*.wasm' {
  const mod: WebAssembly.Module;
  export default mod;
}

declare module '*.ttf' {
  const data: ArrayBuffer;
  export default data;
}
