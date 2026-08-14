"use client";

import Link from "next/link";
import { ArrowLeft, BookOpen, GraduationCap, Timer, Zap } from "lucide-react";

export default function CreateModePage() {
  return (
    <div className="min-h-screen bg-background px-4 py-16">
      <div className="mx-auto max-w-4xl">
        <Link href="/courses" className="mb-8 inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft size={14} /> 返回课程
        </Link>
        <div className="mb-8">
          <h1 className="font-mono text-2xl font-bold text-foreground">选择课程模式</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            先确定内容形态，再填写主题和目标。两种模式都会按你的插图设置自动选择代码渲染图或模型生图。
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Link
            href="/create?mode=lecture"
            className="group rounded-lg border border-border bg-card p-6 transition-colors hover:border-foreground/40"
          >
            <div className="mb-5 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="inline-flex size-10 items-center justify-center rounded-md border border-border bg-background">
                  <Zap size={18} />
                </span>
                <div>
                  <h2 className="font-mono text-lg font-semibold text-foreground">电子讲义</h2>
                  <p className="text-xs text-muted-foreground">快速生成、篇幅更短，可导出讲义 PDF</p>
                </div>
              </div>
            </div>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li className="flex gap-2"><Timer size={15} className="mt-0.5 shrink-0" /> 生成更快、篇幅更短，适合入门、复习和快速了解领域。</li>
              <li className="flex gap-2"><BookOpen size={15} className="mt-0.5 shrink-0" /> 保留课程与章节结构，可导出讲义 PDF 与 TeX。</li>
              <li className="flex gap-2"><GraduationCap size={15} className="mt-0.5 shrink-0" /> 章节按"问题导入 → 核心讲解 → 典型例子 → 要点整理 → 练习"组织。</li>
            </ul>
          </Link>

          <Link
            href="/create?mode=textbook"
            className="group rounded-lg border border-border bg-card p-6 transition-colors hover:border-foreground/40"
          >
            <div className="mb-5 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="inline-flex size-10 items-center justify-center rounded-md border border-border bg-background">
                  <BookOpen size={18} />
                </span>
                <div>
                  <h2 className="font-mono text-lg font-semibold text-foreground">电子教材</h2>
                  <p className="text-xs text-muted-foreground">先确认大纲，再逐章生成系统教材</p>
                </div>
              </div>
            </div>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li className="flex gap-2"><Timer size={15} className="mt-0.5 shrink-0" /> 生成更慢、消耗更多，内容更完整。</li>
              <li className="flex gap-2"><BookOpen size={15} className="mt-0.5 shrink-0" /> 定义、定理、证明、完整推导、章节小结与拓展阅读。</li>
              <li className="flex gap-2"><GraduationCap size={15} className="mt-0.5 shrink-0" /> 面向长期系统研读，可导出教材 PDF 与 TeX。</li>
            </ul>
          </Link>
        </div>
      </div>
    </div>
  );
}
