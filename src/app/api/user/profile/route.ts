import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/apiAuth";
import { getUserProfile, updateUserProfile } from "@/lib/userProfile";

export async function GET(request: Request) {
  const auth = await requireApiUser(request);
  if ("response" in auth) return auth.response;

  const profile = await getUserProfile(auth.userId);
  return NextResponse.json({ profile });
}

export async function PATCH(request: Request) {
  const auth = await requireApiUser(request);
  if ("response" in auth) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const result = await updateUserProfile(auth.userId, body);
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.status });
  }

  return NextResponse.json({ profile: result.profile });
}
