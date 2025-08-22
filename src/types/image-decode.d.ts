declare module 'image-decode' {
  export type Decoded = { width: number; height: number; data: Uint8Array };
  const decode: (data: ArrayBuffer | Uint8Array | Buffer) => Promise<Decoded>;
  export default decode;
}
