//! Genera l'icona di GlassPlay (stile "liquid glass") in PNG e ICO.
//! Disegno originale, nessun asset di terze parti.
//!
//! Uso: cargo run --release -- <cartella-output>

use std::{env, fs, path::PathBuf};
use tiny_skia::*;

/// Lato della tela di progetto: tutte le coordinate sono in questo spazio.
const S: f32 = 1024.0;

fn main() {
    let out = PathBuf::from(env::args().nth(1).expect("uso: icongen <cartella-output>"));
    fs::create_dir_all(&out).expect("impossibile creare la cartella di output");

    for (name, size) in [
        ("32x32.png", 32),
        ("128x128.png", 128),
        ("128x128@2x.png", 256),
        ("icon.png", 512),
        // Sorgente ad alta risoluzione per l'icona macOS (.icns).
        ("icon-1024.png", 1024),
    ] {
        render(size).save_png(out.join(name)).expect("scrittura PNG fallita");
    }

    let mut dir = ico::IconDir::new(ico::ResourceType::Icon);
    for size in [16, 24, 32, 48, 64, 128, 256] {
        let png = render(size).encode_png().expect("encoding PNG fallito");
        let image = ico::IconImage::read_png(png.as_slice()).expect("PNG non valido");
        dir.add_entry(ico::IconDirEntry::encode(&image).expect("encoding ICO fallito"));
    }
    let file = fs::File::create(out.join("icon.ico")).expect("impossibile creare icon.ico");
    dir.write(file).expect("scrittura ICO fallita");

    // Banner per il launcher di Android TV (320×180, densità xhdpi).
    render_banner(320, 180).save_png(out.join("banner.png")).expect("scrittura banner fallita");

    println!("Icone generate in {}", out.display());
}

fn render(size: u32) -> Pixmap {
    let mut pm = Pixmap::new(size, size).unwrap();
    let t = Transform::from_scale(size as f32 / S, size as f32 / S);
    let full = PathBuilder::from_rect(Rect::from_xywh(0.0, 0.0, S, S).unwrap());

    // Base: tile arrotondata con gradiente blu → viola → magenta.
    let tile = rounded_rect(56.0, 56.0, 912.0, 912.0, 220.0);
    fill(&mut pm, &tile, linear((150.0, 80.0), (870.0, 960.0), &[
        (0.0, rgba(0x4d, 0x8d, 0xff, 255)),
        (0.55, rgba(0x6a, 0x4b, 0xff, 255)),
        (1.0, rgba(0xd9, 0x46, 0xef, 255)),
    ]), t, None);

    let mut tile_mask = Mask::new(size, size).unwrap();
    tile_mask.fill_path(&tile, FillRule::Winding, true, t);

    // Bagliori colorati che danno profondità al vetro.
    fill(&mut pm, &full, radial((250.0, 220.0), 460.0, &[
        (0.0, rgba(0x6b, 0xf2, 0xff, 210)),
        (1.0, rgba(0x6b, 0xf2, 0xff, 0)),
    ]), t, Some(&tile_mask));
    fill(&mut pm, &full, radial((830.0, 870.0), 480.0, &[
        (0.0, rgba(0xff, 0x5c, 0xa8, 200)),
        (1.0, rgba(0xff, 0x5c, 0xa8, 0)),
    ]), t, Some(&tile_mask));

    // Ombra morbida sotto la lente.
    fill(&mut pm, &full, radial((512.0, 600.0), 400.0, &[
        (0.0, rgba(0x10, 0x08, 0x40, 110)),
        (0.7, rgba(0x10, 0x08, 0x40, 30)),
        (1.0, rgba(0x10, 0x08, 0x40, 0)),
    ]), t, Some(&tile_mask));

    // Lente di vetro.
    let (cx, cy, r) = (512.0, 512.0, 292.0);
    let lens = PathBuilder::from_circle(cx, cy, r).unwrap();
    fill(&mut pm, &lens, linear((cx, cy - r), (cx, cy + r), &[
        (0.0, rgba(255, 255, 255, 95)),
        (1.0, rgba(255, 255, 255, 28)),
    ]), t, None);

    let mut lens_mask = Mask::new(size, size).unwrap();
    lens_mask.fill_path(&lens, FillRule::Winding, true, t);

    // Caustica luminosa in basso (luce rifratta).
    fill(&mut pm, &full, radial((cx, cy + 250.0), 250.0, &[
        (0.0, rgba(255, 255, 255, 90)),
        (1.0, rgba(255, 255, 255, 0)),
    ]), t, Some(&lens_mask));

    // Riflesso speculare in alto.
    let sheen = PathBuilder::from_circle(cx, cy, r - 14.0).unwrap();
    fill(&mut pm, &sheen, linear((cx, cy - r), (cx, cy - 20.0), &[
        (0.0, rgba(255, 255, 255, 120)),
        (1.0, rgba(255, 255, 255, 0)),
    ]), t, None);

    // Bordo del vetro: più luminoso dove "batte" la luce.
    stroke(&mut pm, &lens, linear((cx - r, cy - r), (cx + r, cy + r), &[
        (0.0, rgba(255, 255, 255, 245)),
        (0.45, rgba(255, 255, 255, 45)),
        (1.0, rgba(255, 255, 255, 170)),
    ]), 10.0, t);

    // Triangolo "play" arrotondato con la sua ombra.
    let play = |dy: f32| {
        let mut pb = PathBuilder::new();
        pb.move_to(456.0, 392.0 + dy);
        pb.line_to(456.0, 648.0 + dy);
        pb.line_to(676.0, 520.0 + dy);
        pb.close();
        pb.finish().unwrap()
    };
    let shadow = play(18.0);
    let shadow_shader = || Shader::SolidColor(rgba(0x20, 0x10, 0x60, 70));
    fill(&mut pm, &shadow, shadow_shader(), t, None);
    stroke_round(&mut pm, &shadow, shadow_shader(), 56.0, t);

    let tri = play(0.0);
    let white = || linear((512.0, 360.0), (512.0, 690.0), &[
        (0.0, rgba(255, 255, 255, 255)),
        (1.0, rgba(0xe6, 0xea, 0xff, 255)),
    ]);
    fill(&mut pm, &tri, white(), t, None);
    stroke_round(&mut pm, &tri, white(), 56.0, t);

    pm
}

/// Banner TV: lo stesso sfondo a gradiente dell'icona, a tutto campo, con l'icona al centro.
fn render_banner(w: u32, h: u32) -> Pixmap {
    let mut pm = Pixmap::new(w, h).unwrap();
    let (fw, fh) = (w as f32, h as f32);
    let full = PathBuilder::from_rect(Rect::from_xywh(0.0, 0.0, fw, fh).unwrap());
    fill(&mut pm, &full, linear((0.0, 0.0), (fw, fh), &[
        (0.0, rgba(0x4d, 0x8d, 0xff, 255)),
        (0.55, rgba(0x6a, 0x4b, 0xff, 255)),
        (1.0, rgba(0xd9, 0x46, 0xef, 255)),
    ]), Transform::identity(), None);
    fill(&mut pm, &full, radial((fw * 0.18, fh * 0.15), fw * 0.55, &[
        (0.0, rgba(0x6b, 0xf2, 0xff, 190)),
        (1.0, rgba(0x6b, 0xf2, 0xff, 0)),
    ]), Transform::identity(), None);
    fill(&mut pm, &full, radial((fw * 0.85, fh * 0.95), fw * 0.6, &[
        (0.0, rgba(0xff, 0x5c, 0xa8, 170)),
        (1.0, rgba(0xff, 0x5c, 0xa8, 0)),
    ]), Transform::identity(), None);
    // Icona centrata, alta poco meno del banner, con un'ombra morbida sotto.
    let side = (fh * 0.82).round() as u32;
    let x = (w - side) as i32 / 2;
    let y = (h - side) as i32 / 2;
    let shadow = PathBuilder::from_circle(fw / 2.0, fh / 2.0 + fh * 0.06, side as f32 * 0.5).unwrap();
    fill(&mut pm, &shadow, radial((fw / 2.0, fh / 2.0 + fh * 0.06), side as f32 * 0.5, &[
        (0.0, rgba(0x10, 0x08, 0x40, 110)),
        (1.0, rgba(0x10, 0x08, 0x40, 0)),
    ]), Transform::identity(), None);
    pm.draw_pixmap(x, y, render(side).as_ref(), &PixmapPaint::default(), Transform::identity(), None);
    pm
}

fn rgba(r: u8, g: u8, b: u8, a: u8) -> Color {
    Color::from_rgba8(r, g, b, a)
}

fn stops(list: &[(f32, Color)]) -> Vec<GradientStop> {
    list.iter().map(|&(p, c)| GradientStop::new(p, c)).collect()
}

fn linear(a: (f32, f32), b: (f32, f32), list: &[(f32, Color)]) -> Shader<'static> {
    LinearGradient::new(
        Point::from_xy(a.0, a.1),
        Point::from_xy(b.0, b.1),
        stops(list),
        SpreadMode::Pad,
        Transform::identity(),
    )
    .unwrap()
}

fn radial(c: (f32, f32), radius: f32, list: &[(f32, Color)]) -> Shader<'static> {
    let p = Point::from_xy(c.0, c.1);
    RadialGradient::new(p, p, radius, stops(list), SpreadMode::Pad, Transform::identity()).unwrap()
}

fn paint(shader: Shader<'static>) -> Paint<'static> {
    Paint { shader, anti_alias: true, ..Default::default() }
}

fn fill(pm: &mut Pixmap, path: &Path, shader: Shader<'static>, t: Transform, mask: Option<&Mask>) {
    pm.fill_path(path, &paint(shader), FillRule::Winding, t, mask);
}

fn stroke(pm: &mut Pixmap, path: &Path, shader: Shader<'static>, width: f32, t: Transform) {
    let s = Stroke { width, ..Default::default() };
    pm.stroke_path(path, &paint(shader), &s, t, None);
}

/// Tratto con giunzioni rotonde: serve ad arrotondare gli spigoli del triangolo.
fn stroke_round(pm: &mut Pixmap, path: &Path, shader: Shader<'static>, width: f32, t: Transform) {
    let s = Stroke { width, line_join: LineJoin::Round, ..Default::default() };
    pm.stroke_path(path, &paint(shader), &s, t, None);
}

fn rounded_rect(x: f32, y: f32, w: f32, h: f32, r: f32) -> Path {
    // k < 0.5523 allunga la curva, avvicinandosi alla "squircle" di Apple.
    let k = 0.45 * r;
    let mut pb = PathBuilder::new();
    pb.move_to(x + r, y);
    pb.line_to(x + w - r, y);
    pb.cubic_to(x + w - k, y, x + w, y + k, x + w, y + r);
    pb.line_to(x + w, y + h - r);
    pb.cubic_to(x + w, y + h - k, x + w - k, y + h, x + w - r, y + h);
    pb.line_to(x + r, y + h);
    pb.cubic_to(x + k, y + h, x, y + h - k, x, y + h - r);
    pb.line_to(x, y + r);
    pb.cubic_to(x, y + k, x + k, y, x + r, y);
    pb.close();
    pb.finish().unwrap()
}
