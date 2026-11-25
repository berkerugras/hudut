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

| Silah (oyunda) | Hasar | Menzil | İtme hızı |
|---|---|---|---|
| Pistol (tabanca) | 20 | 11 | +%30 |
| Rifle (piyade tüfeği) | 11 (seri) | 13 | +%50 |
| Shotgun (pompalı) | 6 × 10 | 6,5 | +%70 |
| Sniper rifle (keskin nişancı) | 75 | 26 | +%40 |
| Rocket launcher (roketatar) | 60 (alan) | 18 | +%100 |

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
