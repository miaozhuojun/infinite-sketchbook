"""配音逐句时间（timing 的 sentences，源配音上的秒数）落到成片旁白（时间线 audioClips）上：旁白检查按句量、按时刻点名用。
不依赖 mlx，自测直接调。

原来按「片段归句」：每个片段按和哪一句重叠最多整段归给那一句。一个分镜短语常含两句（「回到那三条规则。第二条说，听到咳嗽就算有人。」
是同一个片段），短的那句一个片段都分不到，成片上没有范围；它句尾的硬切按时刻对过来落在长的那句里，自动换种子换错了句
（E05 558 秒，两轮草稿白跑）。现在按句子自己在源配音上的起止，经过每个片段映射到成片上。
"""


def sentence_spans(clips, sentences, pad=0.2):
    """每句在成片旁白上的范围 [(k, 起, 止)]（秒）。

    clips：时间线的 audioClips（at、srcIn、srcOut）；sentences：timing 的 sentences（start、end，源配音上的秒数）。
    句子两头各向外放 pad 秒（字头字尾的气声、硬切常落在对齐边界外一点），但不越过相邻句子的边界。
    一句被切成几个片段（中间插了停顿）时，范围从第一段开头到最后一段结尾。
    """
    out = []
    for k, s in enumerate(sentences):
        lo = s["start"] - pad if k == 0 else max(s["start"] - pad, sentences[k - 1]["end"])
        hi = s["end"] + pad if k == len(sentences) - 1 else min(s["end"] + pad, sentences[k + 1]["start"])
        segs = []
        for c in clips:
            a, b = max(c["srcIn"], lo), min(c["srcOut"], hi)
            if b > a:
                segs.append((c["at"] + a - c["srcIn"], c["at"] + b - c["srcIn"]))
        if segs:
            out.append((k, min(a for a, _ in segs), max(b for _, b in segs)))
    return out


def sentence_at(t, spans, side=0.0, tol=0.3):
    """成片旁白上 t 时刻是哪一句（spans 是 sentence_spans 的结果），找不到返回 None。

    side：往哪边看。收音硬切（声音一下断成静音）属于它前面那句，传负数；起音硬切属于它后面那句，传正数。
    两句首尾相接时，边界上的时刻靠 side 分清。不在任何一句里时取 tol 秒内最近的一句。
    """
    p = t + side
    inside = [k for k, a, b in spans if a <= p <= b]
    if inside:
        return inside[-1] if side > 0 else inside[0]
    near = min(((min(abs(p - a), abs(p - b)), k) for k, a, b in spans), default=None)
    return near[1] if near and near[0] <= tol else None
