import { Settings2 } from "lucide-react";
import { ModelSettings } from "@/components/ModelSettings";

export default function ModelConfigPage() {
  return (
    <div className="min-h-screen bg-background pt-16">
      <div className="mx-auto max-w-3xl px-4 py-12">
        <div className="mb-8">
          <h1 className="font-mono text-2xl font-bold text-foreground">模型设置</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            配置生成教材使用的 API Key、Base URL 和模型。登录后设置会同步到你的账户，跨设备使用。
          </p>
        </div>

        <section className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-5 py-4">
            <h2 className="flex items-center gap-2 font-mono text-base font-semibold text-foreground">
              <Settings2 size={16} />
              模型配置
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              当前版本使用你自己填写的 API 生成课程内容；未登录时设置保存在当前浏览器。
            </p>
          </div>
          <div className="px-5 py-6">
            <ModelSettings showLabel />
          </div>
        </section>
      </div>
    </div>
  );
}
