/**
 * mux.js 没有官方类型。这里只声明转封装用到的那一小段。
 * 库本身是 Apache-2.0，版权归 Brightcove。
 */
declare module 'mux.js/lib/mp4/transmuxer' {
  export interface MuxJsSegment {
    initSegment?: Uint8Array
    data?: Uint8Array
    type?: string
  }

  export interface MuxJsSegmentTiming {
    start: { dts: number; pts: number }
    end: { dts: number; pts: number }
    baseMediaDecodeTime: number
  }

  export class Transmuxer {
    constructor(options?: {
      baseMediaDecodeTime?: number
      keepOriginalTimestamps?: boolean
      remux?: boolean
      firstSequenceNumber?: number
    })
    on(event: 'data', listener: (segment: MuxJsSegment) => void): void
    on(event: 'videoSegmentTimingInfo' | 'audioSegmentTimingInfo', listener: (info: MuxJsSegmentTiming) => void): void
    push(data: Uint8Array): void
    flush(): void
    setBaseMediaDecodeTime(baseMediaDecodeTime: number): void
  }
}
