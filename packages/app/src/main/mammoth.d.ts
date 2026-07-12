declare module 'mammoth' {
  export interface ExtractRawTextResult {
    value: string
    messages: unknown[]
  }

  export function extractRawText(input: { path: string } | { buffer: Buffer }): Promise<ExtractRawTextResult>

  const mammoth: {
    extractRawText: typeof extractRawText
  }

  export default mammoth
}
