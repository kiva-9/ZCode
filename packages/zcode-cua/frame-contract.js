/**
 * 官方 CUA 帧契约：截图如何**带着身份**抵达模型。
 *
 * 背景（PRD FR-10 / AC-22）：UI 上显示了截图，不等于模型收到了图。ZCode 的
 * provider 层把 tool result 的媒体块序列化进模型消息，而 Anthropic 兼容网关只解析
 * tool_result.content **开头连续**的 image 块。所以帧必须以「raster + 紧邻权威引用」
 * 的规范形态放在结果最前面，并且带一条能校验的完整性链：
 *
 *   content: [ image, image_ref(text), treeText, advisories... ]
 *   _meta:   { "zcode.cua/official-frame-integrity-v1": { digest, algorithm, frameId, stateId } }
 *
 * `image_ref` 是这套契约的签发载体（与官方实现同一思路）：它是**纯文本** JSON，
 * 携带 frame_id / state_id / 尺寸与 base64 摘要。宿主侧（core 的
 * result-content-projection / image-normalization）据此走 exact-raster 保护路径，
 * 非权威结果里出现同形文本则被剥离 —— 模型无法凭空造出一个能过校验的引用。
 *
 * 压缩的策略（与 CE 占位实现的差异）：CE 的 frame-contract 是占位（全部 return
 * false/undefined），帧只能走通用 MCP 图片路径。这里实现真实契约；超过 inline 预算时
 * 由宿主压缩并**重新签发**摘要（宿主与 producer 同属 ZCode 信任域），保证最终送进
 * 模型消息的那一份仍然通过 attestOfficialCuaFrameContent 校验。
 */
import { createHash } from "node:crypto";
export const OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY = "zcode.cua/official-frame-integrity-v1";
export const OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION = "official_cua_frame_v1";
export const OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES = 200 * 1024;
/** 帧引用的签发方。改这个名字等于换一套契约，必须同步 core 侧的所有消费点。 */
export const OFFICIAL_CUA_IMAGE_REF_AUTHORITY = "zcode-cua";
const DIGEST_ALGORITHM = "sha256";
const DIGEST_PREFIX = `${DIGEST_ALGORITHM}:`;
function digestOf(parts) {
  const hash = createHash(DIGEST_ALGORITHM);
  for (const part of parts) hash.update(typeof part === "string" ? part : JSON.stringify(part));
  return `${DIGEST_PREFIX}${hash.digest("hex")}`;
}
/** 帧摘要：把 raster 字节与身份字段绑在一起，改动任何一项都验不过。 */
export function computeOfficialCuaFrameDigest(input) {
  return digestOf([
    "zcode-cua-frame-v1",
    input.dataBase64 ?? "",
    input.frameId ?? "",
    input.stateId ?? "",
    input.mimeType ?? "",
    input.width ?? "",
    input.height ?? "",
    input.scale ?? "",
  ]);
}
/** 构造 image_ref 文本块（producer 侧签发）。 */
export function buildOfficialCuaImageRef(input) {
  const digest = computeOfficialCuaFrameDigest(input);
  const ref = {
    image_ref: {
      authority: OFFICIAL_CUA_IMAGE_REF_AUTHORITY,
      frame_id: String(input.frameId ?? ""),
      state_id: input.stateId ?? null,
      mime_type: input.mimeType ?? "image/png",
      width: input.width ?? null,
      height: input.height ?? null,
      scale: input.scale ?? null,
      digest,
    },
  };
  return { text: JSON.stringify(ref), digest, ref };
}
function parseJson(text) {
  if (typeof text !== "string") return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
/**
 * 一段文本是否是本契约签发的 image_ref。
 *
 * 判定必须严：单顶层键 `image_ref` + authority 匹配 + digest 形态正确。
 * 松一度都会让模型/第三方伪造的引用混进模型上下文（core 的
 * image-normalization 只剥离「整块即帧引用」的文本，判据就在这）。
 */
export function isOfficialCuaImageRefText(text) {
  const parsed = parseJson(text);
  const ref = parsed?.image_ref;
  if (!ref || typeof ref !== "object") return false;
  if (Object.keys(parsed).length !== 1) return false;
  if (ref.authority !== OFFICIAL_CUA_IMAGE_REF_AUTHORITY) return false;
  if (typeof ref.frame_id !== "string" || !ref.frame_id) return false;
  return typeof ref.digest === "string" && ref.digest.startsWith(DIGEST_PREFIX);
}
export function parseOfficialCuaImageRef(text) {
  if (!isOfficialCuaImageRefText(text)) return undefined;
  const parsed = parseJson(text);
  return { authority: parsed.image_ref.authority, ...parsed.image_ref };
}
/** 文本里是否出现帧引用（用于日志/导出的敏感检查，不判定真伪）。 */
export function containsImageRefAuthority(text) {
  return typeof text === "string" && text.includes(`"${OFFICIAL_CUA_IMAGE_REF_AUTHORITY}"`);
}
/**
 * 文本里是否夹带「看起来像帧引用」的内容。
 *
 * 用途：诊断导出与日志脱敏。出现帧引用本身不敏感，但它可能连同截图元数据一起被
 * 复制到不该去的地方；这里给导出链路一个可判定的信号。
 */
export function containsOfficialCuaImageRefCredentialText(text) {
  if (!containsImageRefAuthority(text)) return false;
  return /"digest"\s*:\s*"sha256:[0-9a-f]{16,}/u.test(text);
}
/** 从结果内容里读出 raster 信封身份（供宿主侧投影与诊断复用）。 */
export function readRasterEnvelopeIdentity(input) {
  const meta = input?._meta;
  const integrity = meta?.[OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY];
  if (!integrity || typeof integrity !== "object") return undefined;
  const algorithm = integrity.algorithm;
  return typeof algorithm === "string" ? { algorithm } : undefined;
}
/**
 * 校验送进模型消息的内容仍然带着 producer 签发的那一帧。
 *
 * core 在序列化后调用它；验不过会让整个工具调用失败（fail-closed）——
 * 「图被换掉/引用被改」比「这次没有图」更危险，所以不能放过。
 */
export function attestOfficialCuaFrameContent(content, expectedKind) {
  if (expectedKind && expectedKind !== OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION)
    return undefined;
  const pair = findOfficialCuaFrameContentPair(content);
  if (!pair) return undefined;
  const ref = parseOfficialCuaImageRef(pair.imageRef.text);
  if (!ref) return undefined;
  const data = pair.image.data;
  if (typeof data !== "string" || !data) return undefined;
  const digest = computeOfficialCuaFrameDigest({
    dataBase64: data,
    frameId: String(ref.frame_id),
    stateId: ref.state_id ?? "",
    mimeType: pair.image.mimeType ?? ref.mime_type,
    width: ref.width,
    height: ref.height,
    scale: ref.scale,
  });
  if (digest !== ref.digest) return undefined;
  return {
    kind: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
    digest,
    frameId: String(ref.frame_id),
  };
}
/** 定位规范帧对：image 在 0、image_ref 紧随其后（core 的投影器要求这个次序）。 */
export function findOfficialCuaFrameContentPair(content) {
  if (!Array.isArray(content) || content.length < 2) return undefined;
  const image = content[0];
  if (!image || typeof image !== "object" || image.type !== "image") return undefined;
  const imageRef = content[1];
  if (!imageRef || typeof imageRef !== "object" || imageRef.type !== "text") return undefined;
  if (!isOfficialCuaImageRefText(imageRef.text)) return undefined;
  return { image, imageRef, imageRefIndex: 1, imageIndex: 0 };
}
/**
 * 把结果整理成「帧对在最前」的规范形态，并附上完整性元数据。
 *
 * producer（本包运行时）在每次带图观察的出口调用它。返回值保持原内容次序语义：
 * image → image_ref → 其余块。即使上游把顺序搞错，这里也纠正 —— core 的投影器对
 * 非规范布局是直接抛错的，宁可在这里修。
 */
/** 宽松定位：相邻的 image + image_ref（用于把上游顺序纠偏到规范布局）。 */
function findAdjacentFramePair(content) {
  if (!Array.isArray(content)) return undefined;
  for (let index = 0; index < content.length - 1; index += 1) {
    const candidate = findOfficialCuaFrameContentPair([content[index], content[index + 1]]);
    if (candidate) return { ...candidate, start: index };
  }
  return undefined;
}

export function attachOfficialCuaFrame(result) {
  if (!result || typeof result !== "object" || !Array.isArray(result.content)) return result;
  let pair = findOfficialCuaFrameContentPair(result.content);
  let rest = result.content.filter((_, index) => index !== 0 && index !== 1);
  if (!pair) {
    const adjacent = findAdjacentFramePair(result.content);
    if (!adjacent) return result;
    pair = { image: adjacent.image, imageRef: adjacent.imageRef };
    rest = result.content.filter(
      (_, index) => index !== adjacent.start && index !== adjacent.start + 1,
    );
  }
  const ref = parseOfficialCuaImageRef(pair.imageRef.text);
  if (!ref) return result;
  const meta = {
    ...result._meta,
    [OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY]: {
      algorithm: DIGEST_ALGORITHM,
      digest: ref.digest,
      frameId: ref.frame_id,
      stateId: ref.state_id ?? null,
    },
  };
  return { ...result, content: [pair.image, pair.imageRef, ...rest], _meta: meta };
}
/**
 * 宿主侧 exact-raster 保护。
 *
 * 小于 inline 预算时**原样保留**（一个字节都不重新编码 —— 坐标契约依赖原始像素）；
 * 超过预算时用 host 的图片端口压缩，并重新签发 image_ref 与完整性元数据，
 * 让「模型收到的那一份」与「attestation 校验的那一份」始终一致。
 */
export async function preserveOfficialCuaFrameResult(result, options = {}) {
  const pair = findOfficialCuaFrameContentPair(result?.content);
  if (!pair) return result;
  const image = pair.image;
  const ref = parseOfficialCuaImageRef(pair.imageRef.text);
  const data = typeof image.data === "string" ? image.data : "";
  if (!ref || !data) return result;
  const isDataUrl = data.startsWith("data:");
  const base64 = isDataUrl ? data.slice(data.indexOf(",") + 1) : data;
  const base64Bytes = Buffer.byteLength(base64, "utf8");
  if (base64Bytes <= OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES) return result;
  const port = options.imageProcessorPort;
  if (!port?.prepareForModel) return result;
  try {
    const prepared = await port.prepareForModel(
      {
        data: Buffer.from(base64, "base64"),
        maxBase64Bytes: OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES,
        maxDimension: 2000,
        maxRawBytes: Math.floor((OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES * 3) / 4),
        mediaType: image.mimeType ?? ref.mime_type,
      },
      { signal: options.signal },
    );
    const nextBase64 = Buffer.from(prepared.data).toString("base64");
    if (
      !nextBase64 ||
      Buffer.byteLength(nextBase64, "utf8") > OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES
    ) {
      return result;
    }
    const nextRef = buildOfficialCuaImageRef({
      frameId: String(ref.frame_id),
      stateId: ref.state_id ?? null,
      mimeType: prepared.mediaType,
      width: ref.width,
      height: ref.height,
      scale: ref.scale,
      dataBase64: nextBase64,
    });
    const nextContent = [
      { type: "image", data: nextBase64, mimeType: prepared.mediaType },
      { type: "text", text: nextRef.text },
      ...result.content.filter((_, index) => index !== 0 && index !== 1),
    ];
    return attachOfficialCuaFrame({ ...result, content: nextContent });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return result;
  }
}
