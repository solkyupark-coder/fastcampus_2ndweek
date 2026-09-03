/**
 * VWorld b3dm 을 loaders.gl 이 읽을 수 있는 모양으로 고쳐 준다.
 *
 * VWorld 타일은 정점을 unsigned short 0~65535 로 눌러 담고,
 * `WEB3D_quantized_attributes` 의 decodeMatrix 로 되돌리게 되어 있다. glTF 1.0 시대 확장이라
 * loaders.gl 은 모른다. 그런데 accessor 에 `normalized: true` 가 붙어 있어서
 * 로더는 0~65535 를 0~1 로 읽고, 결과적으로 33m 짜리 건물이 1m 짜리 나사가 된다.
 *
 * 그래서 서버가 미리 풀어서 FLOAT 로 바꿔 내려보낸다.
 * 겸사겸사 KHR_techniques_webgl 머티리얼(+CRN 압축 텍스처)도 걷어낸다.
 * 브라우저가 디코드하지 못해 InvalidStateError 를 뿜던 그것이다.
 */

type Acc = {
  bufferView?: number; byteOffset?: number; componentType: number; count: number;
  type: string; normalized?: boolean; min?: number[]; max?: number[];
  extensions?: { WEB3D_quantized_attributes?: { decodeMatrix: number[] } };
};
type GLTF = {
  accessors?: Acc[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; target?: number }[];
  buffers?: { byteLength: number }[];
  materials?: unknown[];
  meshes?: { primitives?: { material?: number }[] }[];
  images?: unknown[]; textures?: unknown[]; samplers?: unknown[];
  extensionsUsed?: string[]; extensionsRequired?: string[];
  extensions?: Record<string, unknown>;
};

const NCOMP: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const pad4 = (n: number) => (n + 3) & ~3;

/** b3dm 한 장을 손봐서 돌려준다. 손댈 게 없으면 원본 그대로 */
export function fixB3dm(buf: Buffer): Buffer {
  if (buf.length < 28 || buf.toString("ascii", 0, 4) !== "b3dm") return buf;

  const ftJ = buf.readUInt32LE(12), ftB = buf.readUInt32LE(16);
  const btJ = buf.readUInt32LE(20), btB = buf.readUInt32LE(24);
  const glbOff = 28 + ftJ + ftB + btJ + btB;
  const head = buf.subarray(0, glbOff);
  const glb = buf.subarray(glbOff);
  if (glb.length < 20 || glb.toString("ascii", 0, 4) !== "glTF") return buf;

  const fixed = fixGlb(glb);
  if (!fixed) return buf;

  const out = Buffer.concat([head, fixed]);
  out.writeUInt32LE(out.length, 8);   // b3dm byteLength 갱신
  return out;
}

function fixGlb(glb: Buffer): Buffer | null {
  // GLB 청크: [12바이트 헤더][JSON 청크][BIN 청크]
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.toString("utf8", 20, 20 + jsonLen)) as GLTF;
  const binHeadOff = 20 + pad4(jsonLen);
  if (binHeadOff + 8 > glb.length) return null;
  const binLen = glb.readUInt32LE(binHeadOff);
  const bin = glb.subarray(binHeadOff + 8, binHeadOff + 8 + binLen);

  const extra: Buffer[] = [];
  let extraLen = 0;
  let touched = false;

  for (const acc of json.accessors ?? []) {
    const q = acc.extensions?.WEB3D_quantized_attributes;
    if (!q || acc.bufferView == null) continue;

    const n = NCOMP[acc.type] ?? 1;
    const bv = json.bufferViews![acc.bufferView];
    const start = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const stride = bv.byteStride || n * 2;                 // 5123 = unsigned short
    const m = q.decodeMatrix;                              // (n+1)×(n+1), 열 우선
    // decodeMatrix 는 정규화된 0~1 값에 곱하도록 정의돼 있다(그래서 normalized: true 였다).
    // 원시 ushort 를 그대로 넣으면 좌표가 65535배로 튄다.
    const NORM = 65535;

    const outF = Buffer.alloc(acc.count * n * 4);
    const min = new Array(n).fill(Infinity), max = new Array(n).fill(-Infinity);

    for (let i = 0; i < acc.count; i++) {
      const base = start + i * stride;
      for (let j = 0; j < n; j++) {
        let v = m[n * (n + 1) + j];                        // 마지막 열 = 평행이동
        for (let k = 0; k < n; k++) v += m[k * (n + 1) + j] * (bin.readUInt16LE(base + k * 2) / NORM);
        outF.writeFloatLE(v, (i * n + j) * 4);
        if (v < min[j]) min[j] = v;
        if (v > max[j]) max[j] = v;
      }
    }

    // 새 bufferView 를 뒤에 붙인다. 기존 오프셋은 그대로라 다른 accessor 는 영향 없다
    const off = binLen + extraLen;
    json.bufferViews!.push({ buffer: 0, byteOffset: off, byteLength: outF.length, target: bv.target });
    extra.push(outF);
    extraLen += outF.length;

    acc.bufferView = json.bufferViews!.length - 1;
    acc.byteOffset = 0;
    acc.componentType = 5126;                              // FLOAT
    delete acc.normalized;
    delete acc.extensions!.WEB3D_quantized_attributes;
    acc.min = min; acc.max = max;
    touched = true;
  }

  // CRN 텍스처는 브라우저가 못 푼다. 텍스처를 걷어내고 순백 플랫으로 굽는다.
  //   (deck.gl 의 getColor 는 PBR 머티리얼이 있으면 안 먹으므로 여기서 색을 정한다.)
  //   emissiveFactor 를 흰색으로 줘서 조명·그림자와 무관하게 균일한 흰 덩어리로 보이게.
  // 흰색 무광. 자체발광은 안 준다 — 조명 음영이 남아야 면이 구분되고 형태가 읽힌다.
  json.materials = (json.materials?.length ? json.materials : [{}]).map(() => ({
    pbrMetallicRoughness: { baseColorFactor: [0.93, 0.93, 0.94, 1], metallicFactor: 0, roughnessFactor: 1 },
    doubleSided: true,
  }));
  // 머티리얼이 없던 프리미티브에도 방금 만든 0번 머티리얼을 물린다
  for (const m of json.meshes ?? []) for (const pr of m.primitives ?? []) if (pr.material == null) pr.material = 0;
  delete json.images; delete json.textures; delete json.samplers;
  touched = true;
  const drop = new Set(["WEB3D_quantized_attributes", "KHR_techniques_webgl", "KHR_materials_common"]);
  json.extensionsUsed = (json.extensionsUsed ?? []).filter((e) => !drop.has(e));
  json.extensionsRequired = (json.extensionsRequired ?? []).filter((e) => !drop.has(e));
  if (!json.extensionsRequired.length) delete json.extensionsRequired;
  for (const e of drop) delete json.extensions?.[e];      // CESIUM_RTC 는 남겨야 위치가 맞는다

  if (!touched) return null;

  const newBinLen = binLen + extraLen;
  json.buffers = [{ byteLength: newBinLen }];

  let jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
  if (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(4 - (jsonBuf.length % 4), 0x20)]);
  const binPad = pad4(newBinLen) - newBinLen;

  const total = 12 + 8 + jsonBuf.length + 8 + pad4(newBinLen);
  const out = Buffer.alloc(12 + 8);
  out.write("glTF", 0, "ascii"); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonBuf.length, 12); out.writeUInt32LE(0x4e4f534a, 16);   // 'JSON'
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(pad4(newBinLen), 0); binHead.writeUInt32LE(0x004e4942, 4);  // 'BIN'
  return Buffer.concat([out, jsonBuf, binHead, bin, ...extra, Buffer.alloc(binPad)]);
}
