#!/usr/bin/env node
/**
 * 一次性：生成本地自签名代码签名证书并导入登录钥匙串。
 *
 * 解决什么问题：本地构建（`pnpm build:desktop:local`）产物是 **ad-hoc 签名**，
 * 而 macOS TCC（辅助功能 / 屏幕录制）对 ad-hoc 签名只能按 **CDHash（二进制哈希）**
 * 绑定授权。于是每改一次代码重新构建，CDHash 就变，授权静默失效 —— 用户必须去系统
 * 设置删了再加，而且列表里几条同 id 的条目肉眼分不清是谁（实测踩过）。
 *
 * 换成固定证书后 TCC 按「bundle id + 证书」绑定，重建不再失效。
 *
 * 这东西**只在本机有效**，不进库、不随包分发：
 *   - 私钥/证书落在 ~/.zcode-local-codesign/（700），仓库外；
 *   - 导入的是**登录钥匙串**（用户已登录就处于解锁态）；
 *   - `-T /usr/bin/codesign` 把 codesign 写进私钥 ACL，签名不再弹「允许访问私钥」。
 *
 * 用法：
 *   node scripts/setup-local-codesign-cert.mjs            # 生成并导入（幂等）
 *   node scripts/setup-local-codesign-cert.mjs --status   # 只看状态
 *   node scripts/setup-local-codesign-cert.mjs --remove   # 从钥匙串移除
 *
 * 注意：正式发布包不要用它 —— 分发走 CI 的真实证书（electron-builder 的 CSC）。
 * 它的唯一用途是让**本地迭代构建**的 TCC 授权保持稳定。
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CERT_DIR = join(homedir(), ".zcode-local-codesign");
const KEYCHAIN_PATH = join(homedir(), "Library/Keychains/login.keychain-db");
const CERT_CN = "ZCode Local Dev Codesign";
const KEY_PATH = join(CERT_DIR, "codesign.key.pem");
const CERT_PATH = join(CERT_DIR, "codesign.cert.pem");
const P12_PATH = join(CERT_DIR, "codesign.p12");
/** 只保护本机 p12 备份；导入钥匙串后签名不再需要它。 */
const P12_PASSWORD = "zcode-local-dev";

const args = process.argv.slice(2);
const statusOnly = args.includes("--status");
const remove = args.includes("--remove");

/**
 * 跑命令并回传合并输出（stdout+stderr），失败即抛。
 *
 * 必须合并：`codesign -dvv` 把身份信息写到 **stderr**，execFileSync 只回 stdout，
 * 于是探针永远读不到 Authority（实测：导入成功、签名成功，判定却报不可用）。
 */
function sh(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} 失败（exit ${result.status}）：${output.trim()}`,
    );
  }
  return output;
}

/** 试探性读取：失败不抛，回空串。 */
function trySh(command, commandArgs) {
  try {
    return sh(command, commandArgs);
  } catch {
    return "";
  }
}

/**
 * 就绪判定：用 codesign 对一个小文件实签一次。
 *
 * 不用 `security find-identity`：私钥 ACL 只放了 codesign 时它枚举不到
 * （实测报 "0 valid identities"，但 codesign 用得好好的）。实签是唯一可靠判据。
 */
function probeSigning() {
  try {
    const probe = join(CERT_DIR, ".probe");
    writeFileSync(probe, "probe");
    sh("codesign", ["--force", "--sign", CERT_CN, probe]);
    const authority = sh("codesign", ["-dvv", probe])
      .match(/Authority=(.+)/)?.[1]
      ?.trim();
    rmSync(probe, { force: true });
    return authority === CERT_CN;
  } catch {
    return false;
  }
}

function printStatus() {
  console.log(`[codesign-cert] 目录 ${CERT_DIR} ${existsSync(CERT_DIR) ? "存在" : "不存在"}`);
  const ok = probeSigning();
  console.log(
    ok
      ? `[codesign-cert] ✅ 本地签名身份已就绪：${CERT_CN}（codesign 实签通过）`
      : `[codesign-cert] ❌ 未找到可用的「${CERT_CN}」，运行不带参数的命令生成`,
  );
  return ok;
}

if (statusOnly) {
  process.exit(printStatus() ? 0 : 1);
}

if (remove) {
  try {
    sh("security", ["delete-certificate", "-c", CERT_CN, KEYCHAIN_PATH]);
    console.log(`[codesign-cert] 已从登录钥匙串移除证书：${CERT_CN}`);
  } catch (error) {
    console.log(`[codesign-cert] 移除失败（可能本就不在）：${error.message}`);
  }
  rmSync(CERT_DIR, { recursive: true, force: true });
  console.log(`[codesign-cert] 已删除 ${CERT_DIR}`);
  process.exit(0);
}

if (probeSigning()) {
  console.log(`[codesign-cert] 身份已存在且可签名，幂等退出`);
  printStatus();
  process.exit(0);
}

mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });

// 清同名残留：`security import` 不去重，同名证书导入 N 次就有 N 张，之后
// `codesign --sign <CN>` 直接报 "ambiguous (matches X and X)"。find-certificate
// 一次只返回一条，所以循环删到没有，并按 SHA-1 指纹删（-c 删不掉后面的）。
console.log("[codesign-cert] 清理同名残留…");
for (let round = 0; round < 8; round += 1) {
  const listing = trySh("security", ["find-certificate", "-c", CERT_CN, "-p", KEYCHAIN_PATH]);
  if (!listing.includes("BEGIN CERTIFICATE")) break;
  const tmpPem = join(CERT_DIR, ".existing.pem");
  writeFileSync(tmpPem, listing);
  try {
    const fingerprint = sh("openssl", ["x509", "-in", tmpPem, "-noout", "-fingerprint", "-sha1"])
      .split("=")[1]
      ?.trim()
      .replace(/:/g, "");
    if (!fingerprint) break;
    sh("security", ["delete-certificate", "-Z", fingerprint, KEYCHAIN_PATH]);
  } catch {
    break; // 删不动就别硬删，交给下面的导入与实签判定
  } finally {
    rmSync(tmpPem, { force: true });
  }
}

console.log("[codesign-cert] 生成私钥与自签名证书（10 年）…");
sh("openssl", [
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-keyout",
  KEY_PATH,
  "-out",
  CERT_PATH,
  "-days",
  "3650",
  "-nodes",
  "-subj",
  `/CN=${CERT_CN}`,
  // 代码签名用途必须是 extendedKeyUsage=codeSigning，否则 codesign 不认。
  "-addext",
  "extendedKeyUsage=codeSigning",
  "-addext",
  "keyUsage=digitalSignature",
  "-addext",
  "basicConstraints=CA:false",
]);

console.log("[codesign-cert] 打成 p12 并导入登录钥匙串…");
sh("openssl", [
  "pkcs12",
  "-export",
  "-inkey",
  KEY_PATH,
  "-in",
  CERT_PATH,
  "-out",
  P12_PATH,
  "-passout",
  `pass:${P12_PASSWORD}`,
  // 必须用 3DES+SHA1 的老 PBE 集：OpenSSL 3.6 默认的 PBES2/PBKDF2/AES-256 + SHA256 MAC
  // 在 macOS Security 导入时报 "MAC verification failed during PKCS12 import
  // (wrong password?)" —— 实测（openssl 3.6.4 / macOS 27）只有这组能过。
  "-certpbe",
  "PBE-SHA1-3DES",
  "-keypbe",
  "PBE-SHA1-3DES",
  "-macalg",
  "sha1",
]);
chmodSync(CERT_DIR, 0o700);
chmodSync(KEY_PATH, 0o600);
chmodSync(P12_PATH, 0o600);

// `-T /usr/bin/codesign`：把 codesign 写进私钥 ACL，签名时不再弹「允许访问私钥」。
sh("security", [
  "import",
  P12_PATH,
  "-k",
  KEYCHAIN_PATH,
  "-P",
  P12_PASSWORD,
  "-T",
  "/usr/bin/codesign",
]);

// 自签名证书不在系统信任链里；代码签名只需要证书在钥匙串中，但显式加一次信任
// 可以避免部分策略路径拒绝。失败不影响 codesign 使用。
try {
  sh("security", ["add-trusted-cert", "-p", "codeSign", CERT_PATH]);
} catch (error) {
  console.log(`[codesign-cert] add-trusted-cert 跳过（不影响 codesign）：${error.message}`);
}

if (!printStatus()) {
  console.log("[codesign-cert] ❌ 导入后仍未就绪，请检查钥匙串访问权限");
  process.exit(1);
}
console.log("[codesign-cert] 完成。之后 `pnpm build:desktop:local` 会自动用它签名。");
