// pdf-parse's index.js has a debug code path that reads a sample file on import;
// importing the inner lib avoids it. No bundled types for the subpath, so declare it.
declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info: unknown;
    metadata: unknown;
  }
  function pdf(
    data: Buffer | Uint8Array,
    options?: Record<string, unknown>,
  ): Promise<PdfParseResult>;
  export default pdf;
}
