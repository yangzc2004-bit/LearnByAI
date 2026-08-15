import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/apiAuth";
import { deleteUserAvatar, uploadUserAvatar } from "@/lib/userProfile";

export async function POST(request: Request) {
  const auth = await requireApiUser(request);
  if ("response" in auth) return auth.response;

  const file = await readAvatarFile(request);
  if ("response" in file) return file.response;

  const result = await uploadUserAvatar(auth.userId, file);
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.status });
  }

  return NextResponse.json({ profile: result.profile });
}

export async function DELETE(request: Request) {
  const auth = await requireApiUser(request);
  if ("response" in auth) return auth.response;

  const result = await deleteUserAvatar(auth.userId);
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.status });
  }

  return NextResponse.json({ profile: result.profile });
}

type AvatarFile = {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

async function readAvatarFile(
  request: Request,
): Promise<AvatarFile | { response: NextResponse }> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { response: NextResponse.json({ error: "Invalid multipart form" }, { status: 400 }) };
  }

  const value = form.get("file");
  if (!value || typeof value === "string") {
    return { response: NextResponse.json({ error: "缺少头像文件" }, { status: 400 }) };
  }

  const file = value as File;
  if (typeof file.arrayBuffer !== "function") {
    return { response: NextResponse.json({ error: "无效的头像文件" }, { status: 400 }) };
  }

  return file;
}
