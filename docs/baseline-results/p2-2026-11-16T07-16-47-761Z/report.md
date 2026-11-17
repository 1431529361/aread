# P2/P3-记忆 开发集评测 p2-2026-11-16T07-16-47-761Z

模型：qwen3.8-flash；脚本 0；轮次 0；错误 0

- 抽取 Precision=n/a（0/0），Recall=n/a（0/0）
- 无关误注入率=n/a（0/0）
- 偏好遵从（结构启发式，待人工复核）=n/a（0/0）
- 触发调度比例=n/a（旧基线每轮1次抽取）；抽取完成 P50=nullms；失败 0
- 确定性检查 0/0

## 阈值实验（开发集）

## 注入分层对照
- prefs-only: 注入2条；探针答案见 summary.json
- prefs+goals: 注入3条；探针答案见 summary.json
- prefs+goals+questions: 注入5条；探针答案见 summary.json
- no-memory: 注入5条；探针答案见 summary.json

口径：开发集初测；保留集冻结于 holdout-memory-scripts-p2.json（P4）；旧记忆对照引用 P0 在线基线记录。