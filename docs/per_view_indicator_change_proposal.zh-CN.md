# 单视角指标一致性 — 改动记录（已实施 / AS-BUILT）

> **状态：2026-05-29 已实施。** 最终决定：
> 单视角原图修复只读单视角切片,永不读整张全景。推荐资格**数据驱动**(由 codebook
> 里的 `status` 决定),不用硬编码 id 列表。原先标记的指标按一条规则重新拆分——
> **能从(单视角)图片算出来的 → 保留并显示(打标记);必须靠非图片数据的 → 隐藏为
> 未来开发。**

## 0. 背景

「三视图 pipeline 慢 / 结果不属于任何视角」背后两个问题:

1. **输入 Bug。** 读原图的计算器对每个视角都读 `img.filepath`(整张 **2048×1024**
   全景),而掩膜是按视角裁的 **512×313** 切片。「左视角」的纹理/颜色其实是在整张
   全景上算的。
2. **定义缺口。** 一部分指标的名字/定义建立在全景/半球/模拟视域上;在 120° 切片上
   算,要么不再是名字所指的那个量,要么根本算不出来。

## 1. 第 A 部分 — 单视角输入修复(已完成)

**文件:** `packages/backend/app/api/routes/analysis.py`(逐图循环,约 L1781)。

```python
# 原: photo_path = img.filepath
photo_path = img.mask_filepaths.get("original")
```

- `original` 对全景项目是当前视角切片(左/前/右),对非全景就是单视角副本;彼此不同、
  512×313、与掩膜一致。
- **无 `img.filepath` 回退**:已核对全部 4 个项目,凡有 `semantic_map` 的图都有
  `original`(0 缺失),所以整张全景永不会被读。万一缺失,读原图的计算器会内部退化到
  语义图——也绝不会退到全景。
- 集中式:覆盖全部 20 个读原图计算器;非全景行为不变。

## 2. 第 B 部分 — 数据驱动的推荐资格(已完成)

不用硬编码 id 列表。单一事实来源 =
`Encoding_Dictionary.json → A_indicators[id].status`,经
**`KnowledgeBase.is_recommendable()`** 暴露:可推荐 ⇔ 在 codebook 里且
`status == "active"`(无 status 默认 active);排除 ⇔ `status` 为
`future_development`/`unsupported`,或根本不在 codebook 里(如幽灵 id
`IND_GVI_ANG`)。`recommend_indicators` 和 `recommend_indicators_stream` 都用它
(streaming 路径原来没过滤——一个潜在泄漏,已修)。

### 重新拆分(规则:能从图片算 → 显示;需要非图片数据 → 隐藏)

**保留并显示(重新设为 `status: active`,并打上诚实标记):**

| ID | 标记(`view_scope`) | 为什么能留 |
|---|---|---|
| `IND_SVF` | `per_view_directional` | 纯天空像素比(`Sum(Sky)/Sum(Total)`),完全可从图片算。标注为单视角方向性比值,而非半球 SVF |
| `IND_TVF` | `per_view_directional` | 纯树木像素比,同上 |
| `IND_SQI` | `composite` | 子指标的合成;按你要求保留——输出取决于实际算出的子指标 |
| `IND_HPS` | `composite` | 5 个子分的合成;按你要求保留 |

> SVF/TVF **无需改代码**——它们的计算器本就是读(单视角)语义图的纯 `ratio` 计算器。
> 唯一改动是打诚实标记 + 重新启用。

**隐藏(`status: future_development`,共 7 个)——单视角图片给不了所需数据:**

| ID | 缺的输入 |
|---|---|
| `IND_SVF_DEC` | DSM / 建筑模型模拟 |
| `IND_ENC_BLD` | DSM 模拟 |
| `IND_ENC_TRE` | DSM 模拟 |
| `IND_VSG_BLK` | 周边街道网络 |
| `IND_SHA` | 太阳轨迹(日期/时间/位置)+ 鱼眼天穹 |
| `IND_SVF_CHG` | 相邻两点的差值(空间序列,非单图) |
| `IND_OVH_SHL` | 全景顶视/鸟瞰图——pipeline 只裁左/前/右;**按决定不增加顶视裁剪** |

## 3. 标注(已完成）— 统一 status 词汇

`status` ∈ {`active`, `future_development`} 决定是否推荐;`view_scope`
(`per_view_directional` / `composite`)+ `view_note` 承载诚实含义。

| 位置 | 文件 | 状态 |
|---|---|---|
| 知识库(运行时事实来源) | `data/knowledge_base/Encoding_Dictionary.json → A_indicators` | SVF、TVF、SQI、HPS → `active` + 标记;SVF_CHG、SVF_DEC、ENC_BLD、OVH_SHL、VSG_BLK、SHA → `future_development`(`IND_ENC_TRE` 不在此文件) |
| 指标库(文档) | `data/A_indicators.xlsx`（Indicators_91） | 7 行 `future_development`,其余 `active`(含保留的 4 个) |

`SVCs_P_Evidence.json` / `I_SVCs_Operations.json` 仅按 id 引用,自动继承状态。
计算器 `INDICATOR` 字典不变。

## 4. 记录在案的决定

- 能从图片算的指标**保留并显示**并打诚实标记,而非排除(SVF/TVF 方向性;SQI/HPS 合成)。
- 只有需要**非图片数据**(DSM、太阳轨迹、街网)或**pipeline 不产出的视图**(全景顶视)
  的指标才隐藏。
- `IND_OVH_SHL`:**不**增加顶视裁剪 → 保持隐藏。
- 排除只作用于推荐候选池;任何指标仍可手动选择。

## 5. 验证

- 用真实 KB 模拟 `is_recommendable`:88 个被证据引用的指标里,**82 可推荐 / 6 排除**
  (ENC_BLD、OVH_SHL、SHA、SVF_CHG、SVF_DEC、VSG_BLK——7 个隐藏里出现在证据中的子集);
  SVF、TVF、SQI、HPS 确认恢复可推荐。
- xlsx 与 KB 重读通过;`gemini_client` 三处都调用 `is_recommendable`;无残留硬编码集合。
- **操作要点:** 重启后端以重新加载 `Encoding_Dictionary.json`(知识库启动时缓存),
  否则 status 改动不生效。
- **注意:** 沙箱 bash 挂载对经文件工具编辑的 `.py` 返回了过期快照,无法在沙箱内
  `py_compile`;改动已用权威文件工具核验。本地跑 `python -m app.main` / `npm run build`
  再确认一遍。
