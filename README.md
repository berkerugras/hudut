# Hudut

Dünya haritasında oynanan çok oyunculu bir tarayıcı oyunu. Oyuncular bir ülke seçip o ülkede doğar ve sınırları takım arkadaşlarıyla birlikte iterek ülkelerini büyütür.

## Çalıştırma

Gerekenler: [Node.js](https://nodejs.org) 20 veya üstü.

```
npm install
npm start
```

Sonra tarayıcıda `http://localhost:3000` adresini aç. Aynı ağdaki arkadaşların `http://<bilgisayarının-IP-adresi>:3000` ile katılabilir.

Test ederken silahların hemen gelmesi için geliştirme modunu kullan (silah her 1 dakikada bir gelir):

```
npm run dev
```

## Oyun kuralları

- **Giriş:** Sadece kullanıcı adı. Şifre yok. Oyundaki biri aynı adı kullanıyorsa başka bir ad seçersin.
- **Karakter:** Ten, üst, alt rengi, kafa şekli ve başlık seçilir. Tarayıcı hatırlar; bir sonraki girişte "Hızlı başla" ile tek tıkla oyundasın.
- **Doğma:** Seçtiğin ülkenin içinde doğarsın. O ülkeden oyunda biri varsa onun yanında doğarsın.
- **Sınır itme:** Sadece kendi ülkenin topraklarında yürüyebilirsin. Sınıra doğru yürümeye devam etmek sınırı iter.
  - Bir oyuncu önündeki hücreye 1, yanındaki iki hücreye 0,5 güç uygular.
  - Tek bir oyuncunun gücü hücreyi en fazla **%50** itebilir. Hücreyi geçmek için toplam net güç 2 olmalı, yani **aynı noktaya en az iki kişi** yüklenmeli.
  - Karşı ülkeden biri aynı sınırı geri iterse **aynı güçle** savunur: 2 saldıran ile 1 savunan arasında net güç 1 kalır ve sınır geçilemez.
  - Kimse itmezse sınır yavaşça eski yerine döner.
- **Silahlar:** Her 30 dakikada bir (geliştirme modunda 1 dakikada) oyundaki herkese rastgele bir silah verilir. Silahlar sınırı itme **hızını** artırır (%30 ile %100 arası), ama tek kişinin sınırı geçememe kuralını değiştirmez. Silahla karşı ülkenin oyuncularını vurabilirsin. Vurulan oyuncu 5 saniye sonra kendi ülkesinde yeniden doğar.

| Silah | Hasar | Menzil | İtme hızı |
|---|---|---|---|
| Tabanca | 20 | 11 | +%30 |
| Piyade tüfeği | 11 (seri) | 13 | +%50 |
| Pompalı | 6 × 10 | 6,5 | +%70 |
| Keskin nişancı | 75 | 26 | +%40 |
| Roketatar | 60 (alan) | 18 | +%100 |

Kontroller: `W A S D` veya ok tuşları ile yürü, fare ile nişan al, sol tık ile ateş et, fare tekerleği ile yakınlaş/uzaklaş.

## Ayarlar

| Ortam değişkeni | Varsayılan | Açıklama |
|---|---|---|
| `PORT` | `3000` | Sunucunun dinlediği port |
| `WEAPON_INTERVAL_MIN` | `30` (`npm run dev` ile `1`) | Silah dağıtım aralığı (dakika) |

Sınır ayarları (itme hızı, tek kişi sınırı vb.) `shared/constants.js` dosyasındadır.

## Harita

- Harita Natural Earth verisinden (`world-atlas` paketi) 0,5 derecelik hücrelere çevrilir: 720 × 360 hücre, 234 ülke. Antarktika kimsenin değildir.
- Sınırlar `data/territory.bin` dosyasına 15 saniyede bir kaydedilir. Sunucu yeniden başlayınca sınırlar korunur.
- Haritayı gerçek dünya haline döndürmek için sunucuyu durdurup `npm run reset-map` çalıştır.

## Testler

```
npm test
```

Sınır kurallarını doğrular: tek oyuncu sınırı geçemez, iki oyuncu geçer, bir savunan bir saldıranı dengeler, silah sadece hızı artırır.

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

### Kalıcı yol: barındırma servisi

Arkadaşlarının farklı ağlardan katılması için sunucuyu WebSocket destekleyen bir Node.js barındırma servisine koyman gerekir (örneğin Render, Railway, Fly.io). Kurulum komutu `npm install`, başlatma komutu `npm start`. Ücretsiz planların çoğunda disk kalıcı değildir; sunucu yeniden kurulunca sınırlar gerçek dünya haline döner.

## Klasörler

```
server/   Oyun sunucusu: Express + Socket.IO, saniyede 20 adım simülasyon
shared/   Sunucu ve tarayıcının ortak kullandığı kurallar ve sabitler
public/   Tarayıcı tarafı: ekranlar, Three.js ile 3D sahne, HUD
test/     Sınır kuralı testleri
data/     Oluşturulan harita ve kayıtlı sınırlar (otomatik oluşur)
```
