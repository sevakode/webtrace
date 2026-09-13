# Установка WebTrace 1.0.1 на iPhone

Для своего iPhone достаточно бесплатного Apple Account (**Personal Team**). Подпись действует **7 дней**, затем нужно повторить установку через Xcode. [Условия Apple](https://developer.apple.com/help/account/basics/about-your-developer-account).

Понадобятся Mac с Xcode, Node.js и CocoaPods, iPhone с iOS **16.4 или новее**, кабель и доступ в интернет для установки зависимостей, подписи и открытия сайтов.

Сборка Release 1.0.1 для iPhone проверена компиляцией без подписи. Для установки нужны твоя подпись и подключённый телефон.

## 1. Открыть проект

Если проект ещё не скачан, скопируй его адрес через **Code** на GitHub. Подставь адрес вместо `<repository-url>` и выполни в «Терминале»:

```sh
git clone "<repository-url>" webtrace
cd webtrace
npm ci
npm run recorder
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer pod install --project-directory=ios
open ios/webtrace.xcworkspace
```

Если проект уже подготовлен, открой `ios/webtrace.xcworkspace` из его папки. Открывай именно **`.xcworkspace`**. Native-проекты уже включены в репозиторий: `expo prebuild` для этих шагов не нужен.

## 2. Подключить iPhone

Подключи iPhone кабелем, разблокируй и подтверди **«Доверять этому компьютеру»**. Если нужно, сначала выбери iPhone в Finder и нажми «Доверять» там. [Подключение — Apple](https://support.apple.com/ru-ru/109054).

В верхней панели Xcode выбери схему **webtrace** и свой физический **iPhone**. Если его нет, открой **Manage Devices** в списке устройств или **Window → Devices and Simulators** и дождись подготовки телефона.

## 3. Включить режим разработчика на iPhone

Открой **Настройки → Конфиденциальность и безопасность → Режим разработчика** (*Settings → Privacy & Security → Developer Mode*). Включи его, перезагрузи телефон по запросу, затем **подтверди включение после перезагрузки** и введи код.

Если пункта нет, сначала начни сопряжение с Xcode в шаге 2. [Developer Mode — Apple](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device).

## 4. Выбрать свою подпись

1. Открой **Xcode → Settings → Apple Accounts** (в некоторых версиях **Accounts**) и войди в свой Apple Account.
2. Слева выбери синий значок проекта **webtrace**, затем **TARGETS → webtrace → Signing & Capabilities**.
3. Включи **Automatically manage signing**, выбери **Team → свою Personal Team**. Если видна кнопка **Set Up Signing**, сделай это через неё.
4. Если **Bundle Identifier** `com.anonymous.webtrace` занят, задай уникальный, например `com.example.webtrace.personal` с собственным суффиксом. Используй его для Debug и Release.
5. Дождись исчезновения ошибок подписи. Если появится **Register**, нажми её.

[Настройка подписи и запуск на устройстве — Apple](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices).

При обновлениях сохраняй те же Team и Bundle Identifier. Если позже запустишь Expo prebuild, также запиши идентификатор в `app.json → expo.ios.bundleIdentifier`.

## 5. Собрать автономную версию и установить

1. Открой **Product → Scheme → Edit Scheme…**.
2. Слева выбери **Run**, затем вкладку **Info**.
3. Установи **Build Configuration → Release**. Можно снять **Debug executable**, чтобы запускать без подключённого отладчика. Нажми **Close**. [Параметры схемы Xcode — Apple](https://developer.apple.com/documentation/xcode/customizing-the-build-schemes-for-a-project).
4. Проверь, что сверху выбраны схема **webtrace** и твой **iPhone**.
5. Нажми **▶ Run** или **⌘R** и дождись сборки и установки.

Release включает JavaScript внутрь приложения: **Metro, Expo Go и подключённый Mac не нужны**. Отключи кабель и проверь запуск по иконке WebTrace. Сайты требуют интернет.

**`WebTrace-1.0.1-iOS-Simulator.zip` подходит только симулятору на Mac.** Сборку для телефона с твоей подписью Xcode создаёт в этом шаге.

## 6. Проверить запись и забрать архив

1. Открой WebTrace, вставь ссылку на сайт и нажми **«Открыть»**.
2. Пройди нужный сценарий. Наблюдения появятся во вкладках **«Диплинки»** и **«События»**.
3. Нажми **«Завершить и сохранить ZIP»** и дождись меню отправки.
4. Выбери **«Сохранить в Файлы»** или AirDrop на Mac. Архив можно передать для анализа вместе с содержащимся в нём `ANALYZE.md`.

Завершай запись перед закрытием приложения: незавершённая сессия хранится в памяти.

## Если что-то не получилось

| Что видно | Что сделать |
| --- | --- |
| Ошибка Team или Bundle Identifier | Проверить шаг 4. |
| **Developer Mode disabled** | Выполнить шаг 3 с подтверждением после перезагрузки. |
| **Untrusted Developer / Недоверенный разработчик** | Открыть **Настройки → Основные → VPN и управление устройством**, выбрать свой профиль разработчика и подтвердить доверие. |
| Приложение просит Metro | Выбрать **Run → Info → Release** и повторить **⌘R**. |
| Через неделю перестало запускаться | Подключить iPhone, открыть тот же workspace и повторить **⌘R** с прежними Team и Bundle Identifier. |
| Xcode не поддерживает версию iOS телефона | Установить подходящий Xcode и предложенные им компоненты iOS. |

Сохраняй важные ZIP в «Файлы» или на Mac. Для обычного обновления удалять приложение не нужно: вместе с ним можно потерять локальные архивы.

Для других пользователей iPhone отдельно настраивается распространение, например TestFlight с Apple Developer Program. На Android передавай готовый **`WebTrace-1.0.1-arm64.apk`**.
