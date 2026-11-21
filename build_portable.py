"""Package the static planner as one HTML file, optionally for GitHub Pages."""

import argparse
import json
import re
import shutil
from pathlib import Path
from urllib.parse import urlsplit
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
OUTPUT = ROOT / "portable"
ARCHIVE = ROOT / "Azeroth-Commerce-Authority-Windows.zip"
VERSION = "2.0.0"
ASSETS = (
    "data.json", "maps.json", "routes.json", "geography.json",
    "overview-maps.json", "route-audits.json", "prices.json",
)
SCRIPTS = ("site-config.js", "planner-core.js", "prices.js", "app.js")


def script_json(value):
    # JSON strings must not terminate the surrounding HTML script element.
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")


def https_site_url(value):
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment):
        raise argparse.ArgumentTypeError("Нужен HTTPS-адрес сайта без логина, параметров и фрагмента")
    return value.rstrip("/") + "/"


def replace_once(html, marker, replacement):
    if html.count(marker) != 1:
        raise ValueError(f"Ожидалось одно вхождение в dist/index.html: {marker}")
    return html.replace(marker, replacement, 1)


def portable_instructions(site_url):
    published = f"\nОпубликованная версия: {site_url}\n" if site_url else ""
    return f"""Azeroth Commerce Authority — WoW Forever · {VERSION}

Запуск в Windows 10/11

1. Нажмите правой кнопкой на ZIP и выберите «Извлечь все…».
2. Откройте распакованную папку.
3. Дважды щёлкните по index.html. При выборе приложения укажите
   Microsoft Edge или другой современный браузер.

Python, Node.js, установка программ и локальный сервер не нужны.
Карты, каталог и четыре маршрута встроены в index.html и доступны без сети.
Для кнопки обновления цен и перехода по ссылкам нужен интернет.
Цены относятся к EU PvP Alliance: смотрите дату снимка в интерфейсе.
При неудачном обновлении остаётся предыдущий снимок. Цена выставленного
лота не гарантирует его наличие, нужный размер стека или окупаемость.

Для каждого персонажа создайте отдельный профиль и укажите репутацию
из игры. Покупки, сдачи и репутация сохраняются только в этом браузере.
Следующий круг запускается вручную и сохраняет заработанную репутацию.

Перед заменой HTML-файла, сменой браузера или переносом на другой ПК
экспортируйте резервную копию через интерфейс сайта. Затем импортируйте
её в новой версии. Хранилища файла, localhost и опубликованного сайта
разные; автоматического переноса и синхронизации нет.
Пользуйтесь тем же файлом и браузером; не используйте приватный режим.
Резервная копия содержит ваши профили: храните её у себя.
{published}"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-url", type=https_site_url, help="HTTPS-адрес опубликованного сайта")
    parser.add_argument("--download-directory", type=Path, help="Каталог для дополнительной копии ZIP")
    args = parser.parse_args()

    assets = {name: json.loads((DIST / name).read_text(encoding="utf-8")) for name in ASSETS}
    css = (DIST / "styles.css").read_text(encoding="utf-8")
    scripts = {name: (DIST / name).read_text(encoding="utf-8") for name in SCRIPTS}
    if args.site_url is not None:
        scripts["site-config.js"] = f"window.ACA_SITE={script_json({'version': VERSION, 'url': args.site_url})};\n"
    html = (DIST / "index.html").read_text(encoding="utf-8")
    html = replace_once(html, '<link rel="stylesheet" href="styles.css">', f"<style>\n{css}\n</style>")
    for name in SCRIPTS:
        html = replace_once(html, f'<script src="{name}" defer></script>', "")
    inline = [f"<script>window.ACA_ASSETS={script_json(assets)};</script>"]
    for source in scripts.values():
        source = re.sub(r"</script", r"<\\/script", source, flags=re.IGNORECASE)
        inline.append(f"<script>\n{source}\n</script>")
    html = replace_once(html, "</body>", "\n".join(inline) + "\n</body>")

    # Validate and prepare everything before changing any build output.
    if args.site_url is not None:
        (DIST / "site-config.js").write_text(scripts["site-config.js"], encoding="utf-8")
    OUTPUT.mkdir(exist_ok=True)
    (OUTPUT / "index.html").write_text(html, encoding="utf-8")
    (OUTPUT / "README.txt").write_text(portable_instructions(args.site_url), encoding="utf-8-sig")
    with ZipFile(ARCHIVE, "w", ZIP_DEFLATED) as archive:
        for name in ("index.html", "README.txt"):
            archive.write(OUTPUT / name, name)
    if args.download_directory is not None:
        directory = args.download_directory
        if not directory.is_absolute():
            directory = ROOT / directory
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / ARCHIVE.name
        if target.resolve() != ARCHIVE.resolve():
            shutil.copyfile(ARCHIVE, target)
    print(f"{ARCHIVE} ({ARCHIVE.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
