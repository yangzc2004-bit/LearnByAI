import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/apiAuth";
import { runTerminologyAudit } from "@/lib/maol/terminologyAudit";
import { parseModelOverridesFromHeaders } from "@/lib/modelOverrides";
import { safeErrorMessage } from "@/lib/safeError";
import { getServerCourse } from "@/lib/serverStore";
import { resolveModelOverrides } from "@/lib/userModelConfig";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await requireApiUser(request);
  if ("response" in auth) return auth.response;

  const course = await getServerCourse(id, request);
  if (!course) return NextResponse.json({ error: "Course not found" }, { status: 404 });

  const headerOverrides = parseModelOverridesFromHeaders(request.headers);
  const modelOverrides = await resolveModelOverrides(auth.userId, headerOverrides);

  try {
    const report = await runTerminologyAudit(course, {
      overrides: modelOverrides,
      request,
    });
    const freshCourse = await getServerCourse(id, request);
    return NextResponse.json({ report, course: freshCourse ?? course });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "术语一致性审计失败。") },
      { status: 500 },
    );
  }
}
