import assert from "node:assert/strict";
import { test } from "node:test";
import {
  avatarStoragePathFromUrl,
  inferAvatarMimeType,
  looksLikeAllowedImage,
  parseProfileUpdate,
} from "../../src/lib/profileValidation";

test("profile update requires at least one field and enforces length limits", () => {
  assert.equal(parseProfileUpdate({}).ok, false);
  assert.equal(parseProfileUpdate({ displayName: "x".repeat(31) }).ok, false);
  assert.equal(parseProfileUpdate({ bio: "x".repeat(161) }).ok, false);

  const result = parseProfileUpdate({ displayName: "  小明  ", bio: "  " });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.displayName, "小明");
  assert.equal(result.value.bio, null);
});

test("avatar mime inference accepts browser type or filename extension", () => {
  assert.equal(inferAvatarMimeType("a.png", "image/png"), "image/png");
  assert.equal(inferAvatarMimeType("a.jpg", ""), "image/jpeg");
  assert.equal(inferAvatarMimeType("a.txt", "text/plain"), undefined);
  assert.equal(inferAvatarMimeType("a.svg", "image/svg+xml"), undefined);
});

test("avatar content sniffing rejects mismatched payloads", () => {
  assert.equal(looksLikeAllowedImage(Buffer.from("plain text data", "utf8"), "image/png"), false);
  assert.equal(looksLikeAllowedImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]), "image/jpeg"), true);
  assert.equal(
    looksLikeAllowedImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), "image/png"),
    true,
  );
});

test("avatar storage path is only extracted from the avatar bucket", () => {
  assert.equal(
    avatarStoragePathFromUrl(
      "https://nextome.cn/storage/v1/object/public/learnbyai-avatars/abc/avatar-1.png",
    ),
    "abc/avatar-1.png",
  );
  assert.equal(
    avatarStoragePathFromUrl(
      "https://nextome.cn/storage/v1/object/public/learnbyai-exports/abc/file.pdf",
    ),
    undefined,
  );
  assert.equal(avatarStoragePathFromUrl("not a url"), undefined);
});
