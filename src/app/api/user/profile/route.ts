import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/apiAuth";
import { getUserProfile, updateUserProfile } from "@/lib/userProfile";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const auth = await requireApiUser(request);
  if ("response" in auth) return auth.response;

  const profile = await getUserProfile(auth.userId);
  return NextResponse.json({ profile }, { headers: NO_STORE });
}

export async function PATCH(request: Request) {
  const auth = await requireApiUser(request);
  if ("response" in auth) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: NO_STORE });
  }

  const result = await updateUserProfile(auth.userId, body);
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.status, headers: NO_STORE });
  }

  return NextResponse.json({ profile: result.profile }, { headers: NO_STORE });
}
