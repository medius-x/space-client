/**
 * Vite's `?raw` suffix imports a file as its source TEXT (used to inline the
 * RNNoise emscripten glue into the AudioWorklet blob). The project tsconfig
 * does not include vite/client types, so the module shape is declared here.
 */
declare module "*?raw" {
  const source: string;
  export default source;
}
