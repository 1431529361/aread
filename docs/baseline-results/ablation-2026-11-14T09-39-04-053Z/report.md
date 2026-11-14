# 检索消融对照报告

- 运行: ablation-2026-11-14T09-39-04-053Z
- 向量模型: BAAI/bge-m3
- 重排模型: BAAI/bge-reranker-v2-m3
- 语料hash: {"one-hundred-years":"cd3ef3be0d5ee2c27d7e9aa11396d606310550b7b82348231c456c28bffae01e","confessions":"2a9f2b6bf3f4419a922577aa81450fc12b57922c3d80f78c8e76235fac12b0df"}

| 条件 | 可答题数 | Hit@5 | Recall@5 | MRR@5 | 延迟P50(ms) | 延迟P95(ms) |
| --- | --- | --- | --- | --- | --- | --- |
| bm25 | 16 | 0.750 | 0.625 | 0.580 | 4 | 272 |
| hybrid | 16 | 0.875 | 0.719 | 0.535 | 103 | 308 |
| hybrid+rerank | 16 | 0.813 | 0.656 | 0.688 | 329 | 484 |

## 口径
- 固定 query=question，Top5；金标准为本地原文精确子串（去空白归一）。
- no-answer 题不计入 Hit 分母。延迟含查询向量化与重排调用。
- 混合+重排条件在融合候选上调用重排模型；重排失败保留原序（见 retrieval.jsonl 的 rerank 字段）。
- 本报告为开发集初测，非正式保留集成绩。