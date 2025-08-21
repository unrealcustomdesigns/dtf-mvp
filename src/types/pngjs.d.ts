declare module 'pngjs' {
  export class PNG {
    width: number;
    height: number;
    data: Uint8Array;
    constructor(opts: { width: number; height: number });
    static sync: {
      read(buf: Buffer): { width: number; height: number; data: Uint8Array };
      write(png: { width: number; height: number; data: Uint8Array }): Buffer;
    };
  }
}
