# Hudut

Dünya haritasında oynanan çok oyunculu bir tarayıcı oyunu. Oyuncular bir ülke seçip o ülkede doğar ve sınırları takım arkadaşlarıyla birlikte iterek ülkelerini büyütür.

Oyunun arayüzü, ülke isimleri ve silah isimleri İngilizcedir. Bu belge ve sunucunun terminal mesajları Türkçedir.

## Çalıştırma

Gerekenler: [Node.js](https://nodejs.org) 20 veya üstü.

```
npm install
npm start
```

Sonra tarayıcıda `http://localhost:3000` adresini aç. Aynı ağdaki arkadaşların `http://<bilgisayarının-IP-adresi>:3000` ile katılabilir.

## Oyun kuralları

- **Hızlı giriş:** Açılış ekranında isim (isteğe bağlı) ve büyük bir **PLAY** düğmesi var. Ülke seçmezsen en kalabalık ülkeye girersin; daha önce oynadıysan son ülkene. Karakter ve ülke ekranları isteğe bağlı. Şifre yok; aynı isim o an oyundaysa başka bir isim istenir.
- **Davet linki:** `https://site-adresi/#tr` gibi bir link o ülkeyi seçili açar. Oyunda "Invite friends", ülke ekranında "Copy invite link" bu linki kopyalar. Link paylaşılınca canlı dünya haritasının görseli (`/og.png`) önizleme olarak çıkar.
- **Cephede doğma:** Ülkenden itiş yapan biri varsa onun yanında, yoksa ülkenin sınır hattında doğarsın. "To the front" (`F`) seni 15 saniyede bir cepheye ışınlar.
- **Botlar:** Az oyuncu varken yapay zekâlı askerler (isimleri `AI-` ile başlar) devreye girer. Tek oyunculu bir ülkeye 2 bot takım arkadaşı, komşu rakip ülkeye birkaç düşman bot gelir. Gerçek oyuncular geldikçe botlar çekilir, kimse yokken hepsi gider.
- **Karakter:** Ten, üst, alt rengi, kafa şekli ve başlık. Bere, silindir şapka, taç ve altın üniforma, savaşta kazandığın toplam puanla açılır (300 / 1.000 / 3.000 / 2.000 puan; puan bu tarayıcıda tutulur).
- **Sınır itme:** Sadece kendi ülkenin topraklarında yürüyebilirsin. Sınıra doğru yürümeye devam etmek sınırı iter.
  - Bir oyuncu önündeki hücreye 1, yanındaki iki hücreye 0,5 güç uygular.
  - Tek bir oyuncunun gücü hücreyi en fazla **%50** itebilir. Hücreyi geçmek için toplam net güç 2 olmalı, yani **aynı noktaya en az iki kişi** yüklenmeli.
  - Karşı ülkeden biri aynı sınırı geri iterse **aynı güçle** savunur: 2 saldıran ile 1 savunan arasında net güç 1 kalır ve sınır geçilemez.
  - Kimse itmezse sınır yavaşça eski yerine döner.
- **Silahlar:** Her 30 saniyede bir oyundaki herkese rastgele yeni bir silah verilir (öncekinden farklı). Silahlar sınırı itme **hızını** artırır (%30 ile %100 arası), ama tek kişinin sınırı geçememe kuralını değiştirmez. Silahla karşı ülkenin oyuncularını vurabilirsin. Vurulan oyuncu 5 saniye sonra kendi ülkesinde yeniden doğar.

| Silah (oyunda) | Hasar | Menzil | İtme hızı |
|---|---|---|---|
| Pistol (tabanca) | 20 | 11 | +%30 |
| Rifle (piyade tüfeği) | 11 (seri) | 13 | +%50 |
| Shotgun (pompalı) | 6 × 10 | 6,5 | +%70 |
| Sniper rifle (keskin nişancı) | 75 | 26 | +%40 |
| Rocket launcher (roketatar) | 60 (alan) | 18 | +%100 |

- **Sandıklar:** Cephe hattına her birkaç saniyede bir sandık düşer; üstünden geçen alır. *Medkit* canı doldurur, *Push boost* 12 saniye boyunca 2 kat hızlı iter, *Heavy weapon* roketatar, keskin nişancı ya da pompalı verir.
- **Puan ve sıralama:** Ele geçirmeye katıldığın her hücre 10, başkent 100, vuruş 25, geri püskürttüğün itiş 5 puan. Sağ üstte turun en iyi oyuncuları ve en çok büyüyen ülkeler görünür. Ölünce o canda ne yaptığını (hücre, vuruş, puan, sıra) gösteren bir özet çıkar; "Share" ile paylaşılabilir bir görsel oluşur.
- **Ödül ve moral:** Ölmeden 5 kişi vuranın başına ödül konur (ismi kırmızı yanar); onu vuran 100 puan daha alır. Biri vurulunca vuranın yakınındaki takım arkadaşları 8 saniye %50 hızlı iter.
- **Başkentler:** Yaklaşık 100 başkent haritada bayrakla işaretli. Başkent iki kat yavaş itilir; düşünce herkese duyurulur.
- **Denge:** Küçük ülkeler daha hızlı, çok büyük ülkeler daha yavaş iter ve savunur (en fazla +%50 / −%30). Böylece büyük ülke her şeyi yutamaz.
- **Turlar:** Her 24 saatte bir tur biter; en çok hücre kazanan ülke kazanır, harita gerçek dünyaya döner ve puanlar sıfırlanır.
- **Efektler:** Yakında hücre alınınca parlama ve ses, 4 saniyede 3 hücre alınca "Breakthrough!", vurulunca ekran sarsıntısı, itiş sırasında gürültü. `M` sesi açıp kapatır.
- **Sohbet:** `Enter` sohbet kutusunu açar, mesajı yazıp `Enter` ile gönderirsin, `Esc` kapatır. `Tab` herkese (All) ve sadece kendi ülkene (Team) yazmak arasında geçiş yapar. Mesajlar en fazla 140 karakter; 5 saniyede en fazla 5 mesaj. Küfür ve hakaretler yıldızlanır; sohbette bir isme tıklayınca o oyuncu bu cihazda susturulur.

Kontroller: `W A S D` veya ok tuşları ile yürü, fare ile nişan al, sol tık ile ateş et, fare tekerleği ile yakınlaş/uzaklaş, `Enter` sohbet, `F` cepheye git, `M` ses. "Move: mouse" seçilirse karakter fareyi takip eder (slither tarzı). Telefonda ekranın sol yarısına dokunup sürükleyerek yürürsün; **FIRE** basılı tutulunca en yakın düşmana kendiliğinden nişan alır.

### Hareket nasıl çalışıyor

Her oyuncu kendi karakterini kendi tarayıcısında yürütür ve konumunu sunucuya yollar; böylece yüksek ping'de bile yürüyüş akıcıdır. Sunucu her konumu denetler: yürüme hızıyla oraya varılabiliyor mu, yol boyunca hep kendi toprağında mı? Değilse konumu kabul etmez ve oyuncuyu geri çeker. Diğer oyuncular ekranda 130 ms geriden, iki sunucu görüntüsü arasında yumuşatılarak çizilir.

## Ayarlar

| Ortam değişkeni | Varsayılan | Açıklama |
|---|---|---|
| `PORT` | `3000` | Sunucunun dinlediği port |
| `WEAPON_INTERVAL_SEC` | `30` | Silah dağıtım aralığı (saniye) |
| `ROUND_MINUTES` | `1440` | Bir turun süresi (dakika); varsayılan 24 saat |
| `MAX_BOTS` | `20` | Aynı anda en fazla kaç bot (`0` botları kapatır) |
| `MAX_PLAYERS` | `100` | Aynı anda en fazla kaç gerçek oyuncu |

Sınır ayarları (itme hızı, tek kişi sınırı vb.) `shared/constants.js` dosyasındadır.

## Harita

- Harita Natural Earth verisinden (`world-atlas` paketi) 0,5 derecelik hücrelere çevrilir: 720 × 360 hücre, 234 ülke. Antarktika kimsenin değildir.
- Sınırlar `data/territory.bin` dosyasına 15 saniyede bir kaydedilir. Sunucu yeniden başlayınca sınırlar korunur.
- Haritayı gerçek dünya haline döndürmek için sunucuyu durdurup `npm run reset-map` çalıştır.

## Testler

```
npm test
```

Doğrulananlar: tek oyuncu sınırı geçemez, iki oyuncu geçer, bir savunan bir saldıranı dengeler, silah sadece hızı artırır; normal yürüyüş kabul edilir, ışınlanma ve düşman toprağına girme reddedilir; hızlı giriş en kalabalık ülkeye götürür; ilk oyuncu sınırda doğar; botlar gelir, sınıra yürür ve insan çıkınca gider; vuruş, ödül ve hücre puanları; başkentler; sandıklar; tur sonu ve harita sıfırlanması; "cepheye git"; denge çarpanı; küfür filtresi; önizleme görseli.

## İnternete açmak

### Hızlı yol: ngrok (bilgisayarın açıkken)

İki ayrı terminalde:

```
npm start
```

```
ngrok http 3000
```

ngrok'un verdiği `https://....ngrok-free.app` linkini arkadaşlarınla paylaş. Bilgisayar uyursa ya da bu iki komuttan biri kapanırsa oyun kapanır. Ücretsiz ngrok'ta link her başlatmada değişir. Sabit bir link için ngrok panelinden ücretsiz bir alan adı alıp `ngrok http --url=<alan-adın> 3000` ile başlatabilirsin. Ziyaretçiler ilk girişte ngrok'un bir uyarı sayfasını görür ve "Visit Site" ile geçer.

### Kalıcı yol: Render (ücretsiz)

Proje Render'a hazır: [render.yaml](render.yaml) dosyası sunucunun nasıl kurulacağını Render'a söyler.

1. **GitHub'da boş bir depo aç:** github.com/new → Repository name: `hudut` → Public ya da Private → README, .gitignore, license ekleme seçeneklerini **boş bırak** → Create repository.
2. **Projeyi yükle** (bu klasörde, kullanıcı adını yazarak):
   ```
   git remote add origin https://github.com/<kullanıcı-adın>/hudut.git
   git push -u origin main
   ```
   İlk seferde GitHub girişi için bir tarayıcı penceresi açılabilir.
3. **Render'a bağla:** render.com → GitHub ile giriş yap → üstteki **New** → **Blueprint** → GitHub hesabını bağla ve `hudut` deposunu seç → **Apply**.
4. Birkaç dakikalık kurulumdan sonra Render `https://hudut-....onrender.com` gibi bir adres verir. Bu linki paylaş.
5. **Güncelleme:** Koddaki her değişiklikten sonra `git push` yapman yeterli; Render kendisi yeniden kurar.

Ücretsiz planın sınırları:

- 15 dakika kimse oynamazsa sunucu uyur. Sonraki ilk giriş yaklaşık 1 dakika sürer.
- Disk kalıcı değildir: sunucu her uyuyup uyandığında ya da yeniden kurulduğunda **sınırlar gerçek dünya haline döner**.
- Makine küçüktür (512 MB bellek, 0,1 işlemci); arkadaş grubu için yeterlidir.

## Klasörler

```
server/   Oyun sunucusu: Express + Socket.IO, saniyede 20 adım simülasyon
shared/   Sunucu ve tarayıcının ortak kullandığı kurallar ve sabitler
public/   Tarayıcı tarafı: ekranlar, Three.js ile 3D sahne, HUD
test/     Sınır kuralı testleri
data/     Oluşturulan harita ve kayıtlı sınırlar (otomatik oluşur)
```
