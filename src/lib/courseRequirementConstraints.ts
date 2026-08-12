type ChapterLike = {
  title?: string;
  description?: string;
  purpose?: string;
};

export type ChapterPositionRequirement = {
  chapterNumber: number;
  expectedTitle: string;
  keywords: string[];
};

const GENERIC_TITLE_WORDS = new Set([
  "模型",
  "建模",
  "系统",
  "方法",
  "基础",
  "视角",
  "理论",
  "动态",
  "章节",
]);

export function extractChapterPositionRequirements(
  requirements: string | undefined,
): ChapterPositionRequirement[] {
  if (!requirements?.trim()) return [];

  const matches = requirements.matchAll(
    /第\s*([0-9一二三四五六七八九十百]+)\s*章\s*[“"「『]([^”"」』\r\n]{2,80})[”"」』]/gu,
  );
  const parsed: ChapterPositionRequirement[] = [];

  for (const match of matches) {
    const chapterNumber = parseChapterNumber(match[1]);
    const expectedTitle = match[2]?.trim();
    if (!chapterNumber || !expectedTitle) continue;
    parsed.push({
      chapterNumber,
      expectedTitle,
      keywords: titleKeywords(expectedTitle),
    });
  }

  return dedupeRequirements(parsed);
}

export function assertChapterPositionRequirements(
  chapters: ChapterLike[],
  requirements: string | undefined,
) {
  for (const requirement of extractChapterPositionRequirements(requirements)) {
    const chapter = chapters[requirement.chapterNumber - 1];
    if (!chapter) {
      throw new Error(
        `课程要求指定了第 ${requirement.chapterNumber} 章“${requirement.expectedTitle}”，但大纲没有这一章。`,
      );
    }

    const actualText = [chapter.title, chapter.description, chapter.purpose]
      .filter(Boolean)
      .join(" ");
    if (!matchesExpectedTitle(actualText, requirement)) {
      throw new Error(
        `第 ${requirement.chapterNumber} 章必须对应“${requirement.expectedTitle}”，当前生成的是“${chapter.title ?? "未命名"}”。`,
      );
    }
  }
}

function matchesExpectedTitle(
  actualText: string,
  requirement: ChapterPositionRequirement,
) {
  const actual = normalizeTitle(actualText);
  const expected = normalizeTitle(requirement.expectedTitle);
  if (actual.includes(expected) || expected.includes(actual)) return true;
  if (requirement.keywords.length === 0) return false;

  const matched = requirement.keywords.filter((keyword) =>
    actual.includes(normalizeTitle(keyword)),
  );
  return matched.length >= Math.ceil(requirement.keywords.length / 2);
}

function titleKeywords(title: string) {
  const asciiTerms = title.match(/[A-Za-z][A-Za-z0-9+.-]{1,}/gu) ?? [];
  const chineseTerms = title
    .split(/[的与和及、：:（）()[\]【】《》\s—-]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2)
    .filter((part) => !GENERIC_TITLE_WORDS.has(part));
  return [...new Set([...chineseTerms, ...asciiTerms])];
}

function normalizeTitle(value: string) {
  return value
    .toLowerCase()
    .replace(/[\s：:，,。；;、（）()[\]【】《》“”"'‘’—-]+/gu, "");
}

function dedupeRequirements(requirements: ChapterPositionRequirement[]) {
  const byChapter = new Map<number, ChapterPositionRequirement>();
  for (const requirement of requirements) {
    byChapter.set(requirement.chapterNumber, requirement);
  }
  return [...byChapter.values()].sort(
    (left, right) => left.chapterNumber - right.chapterNumber,
  );
}

function parseChapterNumber(value: string | undefined) {
  if (!value) return undefined;
  if (/^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }

  const digits: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (value === "十") return 10;
  if (value === "百") return 100;

  const hundredParts = value.split("百");
  const hundred = hundredParts.length === 2
    ? (digits[hundredParts[0]] ?? 1) * 100
    : 0;
  const remainder = hundredParts.length === 2 ? hundredParts[1] : value;
  if (!remainder) return hundred;

  const tenParts = remainder.split("十");
  if (tenParts.length === 2) {
    const tens = tenParts[0] ? digits[tenParts[0]] : 1;
    const ones = tenParts[1] ? digits[tenParts[1]] : 0;
    return hundred + tens * 10 + ones;
  }

  return hundred + (digits[remainder] ?? 0) || undefined;
}
