import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/apiAuth";
import { getServerCourse, listServerLectureProgressForCourse } from "@/lib/serverStore";

/**
 * Course-wide lecture progress map: { [chapterId]: LectureProgress } for the
 * course page's chapter cards.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await requireApiUser(request);
  if ("response" in auth) return auth.response;

  const course = await getServerCourse(id, request);
  if (!course) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }

  const progressList = await listServerLectureProgressForCourse(id, request);
  const progress = Object.fromEntries(
    progressList
      .filter((item) => course.chapters.some((chapter) => chapter.id === item.chapterId))
      .map((item) => [item.chapterId, item]),
  );
  return NextResponse.json({ progress });
}
