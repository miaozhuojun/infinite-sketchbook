"""旁白检查点名要换种子重配的句子（写进 <时间线>.revoice.json，流水线据此自动换种子重配，最多两轮）。
按句量的数（回声、沙沙声）超了关卡时，挑哪几句：speech_check.py 用，单独放出来好做单元检查（不载模型、不要 numpy）。
vals 都是 [(句号, 这一句量出来的数)]，返回要重配的句号。阈值就是关卡自己的上限，这里不另设。
"""


def over(vals, limit):
    """关卡管的是最差的一句（「每句没有回声」：最长一句不超过上限）：超过上限的每一句都重配"""
    return [k for k, v in vals if v > limit]


def median_over(vals, limit):
    """关卡管的是全片中位数（「说话时没有沙沙声」：中位数不超过上限）：中位数超了时，只重配最高的那几句，
    够把中位数拉回上限以内就行（假定重配过的都降到上限以下：n 句里超过上限的不多于 (n-1)//2 句，中位数就不超）。
    中位数没超返回空。不把超过上限的句子全点名：中位数超了说明一半以上都超，全点名要重配半集，
    差一点超的时候换掉最高的一两句就够了（整条都沙沙响，多半是参考音带底噪，重配也没用，要先去噪）"""
    if not vals:
        return []
    vs = sorted(v for _, v in vals)
    n = len(vs)
    med = vs[n // 2] if n % 2 else (vs[n // 2 - 1] + vs[n // 2]) / 2
    if med <= limit:
        return []
    above = [k for k, v in sorted(vals, key=lambda q: -q[1]) if v > limit]
    return above[:len(above) - (n - 1) // 2]
