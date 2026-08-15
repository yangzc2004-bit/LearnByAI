import { Settings2 } from "lucide-react";
import { ModelSettings } from "@/components/ModelSettings";

export default function AccountModelPage() {
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <h2 className="flex items-center gap-2 font-mono text-base font-semibold text-foreground">
          <Settings2 size={16} />
          模型设置
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          当前版本使用你自己填写的 API Key、Base URL 和模型进行生成，设置会同步到你的账户。
        </p>
      </div>
      <div className="px-5 py-6">
        <ModelSettings showLabel />
      </div>
    </section>
  );
}
