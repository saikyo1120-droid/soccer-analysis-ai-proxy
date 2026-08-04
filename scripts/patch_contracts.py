import re, sys

path = "/tmp/soccer-analysis-ai/index.html"
with open(path, encoding="utf-8") as f:
    text = f.read()

# ---- 1. targeted club/career fixes for a few players whose status my research corrected ----
fixes = [
    # ofli: now on loan to Karlsruher SC
    ('flag: "🇩🇪", country: "ドイツ(トルコ系)", club: "バイエルン・ミュンヘン", birth: "2007-03-29",',
     'flag: "🇩🇪", country: "ドイツ(トルコ系)", club: "バイエルン・ミュンヘン(カールスルーアSCへ期限付き移籍中)", birth: "2007-03-29",'),
    # buchmann: now on loan to 1.FC Nürnberg
    ('flag: "🇩🇪", country: "ドイツ", club: "バイエルン・ミュンヘン", birth: "2005-02-28",',
     'flag: "🇩🇪", country: "ドイツ", club: "バイエルン・ミュンヘン(1.FCニュルンベルクへ期限付き移籍中)", birth: "2005-02-28",'),
    # sieb: on loan to Mainz 05
    ('flag: "🇩🇪", country: "ドイツ(モザンビーク/マダガスカル系)", club: "バイエルン・ミュンヘン", birth: "2003-02-17",',
     'flag: "🇩🇪", country: "ドイツ(モザンビーク/マダガスカル系)", club: "バイエルン・ミュンヘン(マインツ05へ期限付き移籍中)", birth: "2003-02-17",'),
    # chavez: loan to Koln has ended, back at Bayern
    ('flag: "🇵🇪", country: "ペルー(ドイツ生まれ)", club: "バイエルン・ミュンヘン(1.FCケルンへ期限付き移籍中)", birth: "2007-04-10",',
     'flag: "🇵🇪", country: "ペルー(ドイツ生まれ)", club: "バイエルン・ミュンヘン", birth: "2007-04-10",'),
    # della rovere: career field, not pure academy - joined from Cremonese
    ('career: ["バイエルン・ミュンヘン(下部組織)"],\n    titles: [],\n    scouting: { strengths: ["技術と判断力で下部組織でも高い評価を得ている。"], weaknesses: ["トップレベルでの実戦経験はこれから。"] }',
     'career: ["クレモネーゼ(イタリア)", "バイエルン・ミュンヘン"],\n    titles: [],\n    scouting: { strengths: ["技術と判断力で高い評価を得ている。"], weaknesses: ["トップレベルでの実戦経験はこれから。"] }'),
]
for old, new in fixes:
    n = text.count(old)
    if n != 1:
        print(f"WARNING: expected 1 occurrence, found {n}: {old[:80]}", file=sys.stderr)
    else:
        text = text.replace(old, new)

with open(path, "w", encoding="utf-8") as f:
    f.write(text)
print("done fixes")
