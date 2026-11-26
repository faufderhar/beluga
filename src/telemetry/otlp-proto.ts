/**
 * OTLP traces as protobuf (opentelemetry-proto, trace/v1 and common/v1). This is the one encoding
 * every OTLP/HTTP endpoint must take. Some tools take only it: Databricks refuses JSON, and Logfire,
 * New Relic, LangSmith and Arize document only protobuf. Your own trace destinations get this.
 * Usage statistics keep JSON for Ratel. The input is the JSON request tracesRequest builds (otlp.ts),
 * so both say the same thing.
 */

type Json = Readonly<Record<string, unknown>>;

/** A growable byte buffer with protobuf's wire types. */
class Writer {
  private chunks: number[] = [];

  bytes(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }

  private varint(n: bigint): void {
    let v = BigInt.asUintN(64, n);
    while (v > 0x7fn) {
      this.chunks.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    this.chunks.push(Number(v));
  }

  private tag(field: number, wire: number): void {
    this.varint(BigInt((field << 3) | wire));
  }

  uint(field: number, n: number | bigint): void {
    this.tag(field, 0);
    this.varint(BigInt(n));
  }

  bool(field: number, b: boolean): void {
    this.uint(field, b ? 1 : 0);
  }

  fixed64(field: number, n: bigint): void {
    this.tag(field, 1);
    let v = BigInt.asUintN(64, n);
    for (let i = 0; i < 8; i++) {
      this.chunks.push(Number(v & 0xffn));
      v >>= 8n;
    }
  }

  double(field: number, n: number): void {
    this.tag(field, 1);
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, n, true);
    this.chunks.push(...b);
  }

  raw(field: number, data: Uint8Array): void {
    this.tag(field, 2);
    this.varint(BigInt(data.length));
    for (const x of data) this.chunks.push(x);
  }

  string(field: number, s: string): void {
    this.raw(field, new TextEncoder().encode(s));
  }

  message(field: number, write: (w: Writer) => void): void {
    const inner = new Writer();
    write(inner);
    this.raw(field, inner.bytes());
  }
}

const hex = (s: unknown): Uint8Array => {
  const t = typeof s === 'string' && /^[0-9a-f]*$/i.test(s) && s.length % 2 === 0 ? s : '';
  return Uint8Array.from(t.match(/../g) ?? [], (b) => parseInt(b, 16));
};
const list = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const big = (v: unknown): bigint => {
  try {
    return BigInt(typeof v === 'string' || typeof v === 'number' ? v : 0);
  } catch {
    return 0n;
  }
};

/** common.v1.AnyValue */
function anyValue(w: Writer, v: Json): void {
  if (typeof v.stringValue === 'string') w.string(1, v.stringValue);
  else if (typeof v.boolValue === 'boolean') w.bool(2, v.boolValue);
  else if (v.intValue !== undefined) w.uint(3, big(v.intValue));
  else if (typeof v.doubleValue === 'number') w.double(4, v.doubleValue);
  else if (v.arrayValue && typeof v.arrayValue === 'object') w.message(5, (a) => list((v.arrayValue as Json).values).forEach((x) => a.message(1, (e) => anyValue(e, x))));
}

/** repeated common.v1.KeyValue at `field` */
function keyValues(w: Writer, field: number, attrs: unknown): void {
  for (const a of list(attrs)) {
    if (typeof a.key !== 'string') continue;
    w.message(field, (kv) => {
      kv.string(1, a.key as string);
      kv.message(2, (v) => anyValue(v, (a.value ?? {}) as Json));
    });
  }
}

/** trace.v1.Span */
function span(w: Writer, s: Json): void {
  w.raw(1, hex(s.traceId));
  w.raw(2, hex(s.spanId));
  if (s.parentSpanId) w.raw(4, hex(s.parentSpanId));
  w.string(5, String(s.name ?? ''));
  if (typeof s.kind === 'number') w.uint(6, s.kind);
  w.fixed64(7, big(s.startTimeUnixNano));
  w.fixed64(8, big(s.endTimeUnixNano));
  keyValues(w, 9, s.attributes);
  for (const e of list(s.events)) {
    w.message(11, (ev) => {
      ev.fixed64(1, big(e.timeUnixNano));
      ev.string(2, String(e.name ?? ''));
      keyValues(ev, 3, e.attributes);
    });
  }
  const status = s.status as Json | undefined;
  if (status) {
    w.message(15, (st) => {
      if (typeof status.message === 'string' && status.message) st.string(2, status.message);
      if (typeof status.code === 'number') st.uint(3, status.code);
    });
  }
}

/** An ExportTraceServiceRequest from its JSON shape (otlp.ts tracesRequest). */
export function tracesProto(request: unknown): Uint8Array {
  const w = new Writer();
  for (const rs of list((request as Json | undefined)?.resourceSpans)) {
    w.message(1, (r) => {
      const res = rs.resource as Json | undefined;
      if (res) r.message(1, (x) => keyValues(x, 1, res.attributes));
      for (const ss of list(rs.scopeSpans)) {
        r.message(2, (sc) => {
          const scope = ss.scope as Json | undefined;
          if (scope)
            sc.message(1, (x) => {
              if (typeof scope.name === 'string') x.string(1, scope.name);
              if (typeof scope.version === 'string') x.string(2, scope.version);
            });
          for (const s of list(ss.spans)) sc.message(2, (x) => span(x, s));
        });
      }
    });
  }
  return w.bytes();
}
