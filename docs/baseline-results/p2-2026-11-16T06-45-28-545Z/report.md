# P2/P3-记忆 开发集评测 p2-2026-11-16T06-45-28-545Z

模型：qwen3.8-flash；脚本 10；轮次 17；错误 1

- 抽取 Precision=100.0%（9/9），Recall=90.0%（9/10）
- 无关误注入率=0.0%（0/2）
- 偏好遵从（结构启发式，待人工复核）=33.3%（1/3）
- 触发调度比例=64.7%（旧基线每轮1次抽取）；抽取完成 P50=22532ms；失败 1
- 确定性检查 3/3

## 阈值实验（开发集）
- th=0.15: 相关召回=100.0% 无关注入=n/a (rel=1, irr=0)
- th=0.25: 相关召回=100.0% 无关注入=n/a (rel=1, irr=0)
- th=0.35: 相关召回=0.0% 无关注入=n/a (rel=1, irr=0)

## 注入分层对照
- prefs-only: 注入0条；探针答案见 summary.json
- prefs+goals: 注入0条；探针答案见 summary.json
- prefs+goals+questions: 注入1条；探针答案见 summary.json
- no-memory: 注入1条；探针答案见 summary.json

口径：开发集初测；保留集冻结于 holdout-memory-scripts-p2.json（P4）；旧记忆对照引用 P0 在线基线记录。