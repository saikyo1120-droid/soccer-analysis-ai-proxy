# -*- coding: utf-8 -*-
import sys, json

path = "/tmp/soccer-analysis-ai/index.html"
with open(path, encoding="utf-8") as f:
    text = f.read()

def js_str(s):
    if s is None:
        return "null"
    return json.dumps(s, ensure_ascii=False)

def contract_snippet(c):
    # c: dict with type, amount(optional), fromClub(optional), date(optional), note(optional)
    parts = [f'type: {js_str(c["type"])}']
    parts.append(f'amount: {js_str(c.get("amount"))}')
    parts.append(f'fromClub: {js_str(c.get("fromClub"))}')
    parts.append(f'date: {js_str(c.get("date"))}')
    parts.append(f'note: {js_str(c.get("note"))}')
    return "{ " + ", ".join(parts) + " }"

CONTRACTS = {
  "messi": dict(type="free", fromClub="パリ・サンジェルマン", date="2023年7月",
    note="契約満了に伴うフリー移籍でインテル・マイアミへ。"),
  "ronaldo": dict(type="free", fromClub="マンチェスター・ユナイテッド", date="2023年1月",
    note="契約解除後のフリー移籍。アル・ナスルとは2027年までの契約延長で合意済み。"),
  "mbappe": dict(type="free", fromClub="パリ・サンジェルマン", date="2024年7月",
    note="契約満了に伴うフリー移籍。"),
  "haaland": dict(type="release_clause", amount="£51.2m", fromClub="ボルシア・ドルトムント", date="2022年7月",
    note="解放条項(リリースクローズ)を行使しての完全移籍。"),
  "debruyne": dict(type="free", fromClub="マンチェスター・シティ", date="2025年6月",
    note="契約満了に伴うフリー移籍でナポリへ。"),
  "bsilva": dict(type="free", fromClub="マンチェスター・シティ", date="2026年6月",
    note="契約満了に伴うフリー移籍でレアル・マドリードへ。"),
  "yamal": dict(type="homegrown", date=None,
    note="ラ・マシア(下部組織)出身の生え抜き。移籍金は発生していないが、高額な違約金(release clause)付きの契約延長が報じられている。"),
  "kubo": dict(type="fee", amount="約£5.5m", fromClub="レアル・マドリード", date="2023年8月",
    note="レアル・マドリードが将来の売却時利益配分条項を保持しているとされる。"),

  "urbig": dict(type="fee", amount="約€8m", fromClub="1.FCケルン", date="2025年1月"),
  "neuer": dict(type="fee", amount="約€18〜22m(報道により幅あり)", fromClub="FCシャルケ04", date="2011年"),
  "ulreich": dict(type="free", fromClub="VfBシュトゥットガルト", date="2015年7月"),
  "baertl": dict(type="homegrown", note="下部組織出身。"),
  "prescott": dict(type="homegrown", note="下部組織出身(米国生まれ)。"),
  "klanac": dict(type="homegrown", note="下部組織出身。"),
  "upamecano": dict(type="release_clause", amount="約€42.5m", fromClub="RBライプツィヒ", date="2021年7月"),
  "kimminjae": dict(type="fee", amount="約€50m(報道)", fromClub="SSCナポリ", date="2023年7月",
    note="実際の受領額は報道より低いとの言及もある。2026年も残留が確認されている。"),
  "tah": dict(type="free", fromClub="バイエル・レバークーゼン", date="2025年5月"),
  "kimmich": dict(type="undisclosed", fromClub="RBライプツィヒ(下部組織)", date="2015年",
    note="正確な移籍金は一次情報で確認できていません(概ね€8〜9m規模と伝えられています)。"),
  "davies": dict(type="fee", amount="約$13.5〜22m(出来高含む、報道により幅あり)", fromClub="バンクーバー・ホワイトキャップスFC(MLS)", date="2018年7月"),
  "ito": dict(type="fee", amount="約€23〜30m(報道により幅あり)", fromClub="VfBシュトゥットガルト", date="2024年6月"),
  "boey": dict(type="fee", amount="€30m", fromClub="ガラタサライ", date="2024年1月",
    note="2025-26シーズンはガラタサライへ期限付き移籍していたが、その後バイエルンに復帰。"),
  "buchmann": dict(type="homegrown", note="下部組織出身。現在は1.FCニュルンベルクへ期限付き移籍中。"),
  "ofli": dict(type="homegrown", note="下部組織出身。現在はカールスルーアSCへ買取オプション付きで期限付き移籍中。"),
  "manuba": dict(type="homegrown", note="下部組織出身。"),
  "stanisic": dict(type="homegrown", note="下部組織出身。2024-25シーズンはバイエル・レバークーゼンへ期限付き移籍していたが、2025-26シーズンにバイエルンへ復帰し契約を延長。"),
  "brown": dict(type="fee", amount="約€55m(報道)", fromClub="アイントラハト・フランクフルト", date="2026年7月"),

  "musiala": dict(type="undisclosed", fromClub="チェルシー(下部組織)", date="2019年2月",
    note="移籍金は低額・非公開とされるが、チェルシーへの将来の売却時利益配分条項(セルオン)が付帯していると報じられている。"),
  "palhinha": dict(type="fee", amount="£47.4m(約€56m)", fromClub="フラム", date="2024年7月"),
  "zaragoza": dict(type="fee", amount="約€15m", fromClub="グラナダCF", date="2024年1月",
    note="2026年時点で売却が検討されているとも報じられている。"),
  "ibrahimovic": dict(type="homegrown", note="下部組織出身。2025年にハイデンハイムへの期限付き移籍から復帰し、2028年まで契約延長。"),
  "bischof": dict(type="free", fromClub="ホッフェンハイム", date="2025年1月",
    note="基本はフリー移籍だが、クラブワールドカップ出場のため早期合流の対価として少額の移籍金(約€250〜300k)が支払われたと報じられている。"),
  "laimer": dict(type="free", fromClub="RBライプツィヒ", date="2023年6月"),
  "dellarovere": dict(type="undisclosed", fromClub="クレモネーゼ(イタリア)", date="2025年2月頃",
    note="下部組織出身ではなく、イタリアのクラブからの完全移籍(金額非公開)。"),
  "fernandez": dict(type="undisclosed", fromClub="アトレティコ・マドリード(下部組織)", date="2022年11月",
    note="現在は1.FCニュルンベルクへ期限付き移籍中(2026年6月に延長)。"),
  "saibari": dict(type="fee", amount="約€50m", fromClub="PSVアイントホーフェン", date="2026年7月"),
  "chavez": dict(type="undisclosed", fromClub="バイエルン下部組織", date=None,
    note="1.FCケルンへの期限付き移籍が終了しバイエルンに復帰(買取オプションは行使されず)。"),
  "karl": dict(type="homegrown", note="下部組織出身。"),
  "pavlovic": dict(type="homegrown", note="下部組織出身。クラブのボールボーイだったことでも知られる生え抜き選手。"),
  "daiber": dict(type="homegrown", note="下部組織出身。"),
  "cardozo": dict(type="homegrown", date="2025年2月",
    note="バイエルンの育成プログラム(FC Bayern World Squad)経由での加入で、移籍金は発生していない。"),
  "gnabry": dict(type="free", fromClub="ヴェルダー・ブレーメン", date="2017年",
    note="2028年まで契約を延長済み(2026年2月)。"),
  "kane": dict(type="fee", amount="約£100m(報道)", fromClub="トッテナム・ホットスパー", date="2023年8月",
    note="実際の支払額はやや低かったとの報道もある。"),
  "diaz": dict(type="fee", amount="約€75m(英報道では£65.5mとも)", fromClub="リヴァプール", date="2025年7月"),
  "olise": dict(type="fee", amount="£50.8m", fromClub="クリスタル・パレス", date="2024年7月"),
  "sieb": dict(type="homegrown", note="ホッフェンハイムから加入後、バイエルンが買い戻しオプションを行使。現在はマインツ05へ期限付き移籍中。"),
  "assomo": dict(type="homegrown", note="下部組織出身(ドイツ・カメルーン系)。"),
}

count = 0
for key, c in CONTRACTS.items():
    marker = f'\n  {key}: {{\n'
    idx = text.find(marker)
    if idx == -1:
        print(f"MISSING KEY BLOCK: {key}", file=sys.stderr)
        continue
    scouting_idx = text.find("\n    scouting: {", idx)
    if scouting_idx == -1:
        print(f"MISSING scouting for: {key}", file=sys.stderr)
        continue
    snippet = f"\n    contract: {contract_snippet(c)},"
    text = text[:scouting_idx] + snippet + text[scouting_idx:]
    count += 1

with open(path, "w", encoding="utf-8") as f:
    f.write(text)
print(f"inserted contract into {count} players")
