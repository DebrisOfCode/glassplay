//! Filtro dei contenuti per adulti: solo nella versione legacy (feature "adult-filter").
//!
//! Le liste IPTV raccolgono questi contenuti in gruppi dedicati ("XXX", "For Adults", "18+"...):
//! ogni gruppo si giudica una volta sola e il giudizio vale per tutti i suoi canali. Per i nomi
//! dei canali bastano parole intere e inequivocabili (marchi di canali per adulti): parole come
//! "xxx" o "porno" compaiono anche in titoli comuni ("xXx" con Vin Diesel, "The Deuce - La via
//! del porno"). Il controllo è un solo passaggio sul testo: per ogni carattere basta guardare una
//! tabella dei possibili inizi di parola.

/// Parole che rendono "per adulti" un intero gruppo, anche dentro altre parole ("adulti", "porno").
const GROUP_WORDS: &[&str] = &[
    "xxx", "adult", "18+", "+18", "porn", "erotic", "erotik", "hentai", "nsfw", "erwachsen", "взросл",
    "yetişkin", "dorosł", "playboy", "brazzers", "hustler", "penthouse", "dorcel", "redlight",
];

/// Nomi di canali per adulti, come parole intere.
const NAME_WORDS: &[&str] = &[
    "brazzers", "dorcel", "redlight", "babestation", "playboy tv", "hustler tv", "blue hustler", "penthouse tv",
    "penthouse gold", "penthouse passion", "penthouse black", "hentai", "18+", "+18", "nsfw",
];

/// Primi byte delle parole: gli altri caratteri si saltano subito.
const fn first_bytes(words: &[&str]) -> [bool; 256] {
    let mut table = [false; 256];
    let mut i = 0;
    while i < words.len() {
        table[words[i].as_bytes()[0] as usize] = true;
        i += 1;
    }
    table
}

const GROUP_FIRST: [bool; 256] = first_bytes(GROUP_WORDS);
const NAME_FIRST: [bool; 256] = first_bytes(NAME_WORDS);

/// `text` (in minuscolo) contiene una delle parole? Con `whole`, solo come parola intera.
fn contains_any(text: &str, words: &[&str], first: &[bool; 256], whole: bool) -> bool {
    let bytes = text.as_bytes();
    let alnum = |i: usize| bytes.get(i).is_some_and(|b| b.is_ascii_alphanumeric() || *b >= 0x80);
    (0..bytes.len()).any(|i| {
        first[bytes[i] as usize]
            && (!whole || i == 0 || !alnum(i - 1))
            && words.iter().any(|w| {
                let rest = &bytes[i..];
                rest.starts_with(w.as_bytes())
                    && (!whole || !alnum(i + w.len()))
                    // "Adult Swim" è il blocco di cartoni di Cartoon Network, non un canale per adulti.
                    && !(*w == "adult" && rest[5..].starts_with(b" swim"))
            })
    })
}

/// Giudizi già dati sui gruppi, per indice del gruppo (vedi `Pool` in store.rs).
#[derive(Default)]
pub struct Filter {
    groups: Vec<Option<bool>>,
}

impl Filter {
    /// Il canale va nascosto? `name` è in minuscolo; `group` è l'indice del gruppo nella lista
    /// con il suo nome in minuscolo (`None` se il canale non ha un gruppo).
    pub fn hides(&mut self, name: &str, group: Option<(u32, &str)>) -> bool {
        if let Some((id, text)) = group {
            let id = id as usize;
            if id >= self.groups.len() {
                self.groups.resize(id + 1, None);
            }
            let adult = *self.groups[id].get_or_insert_with(|| contains_any(text, GROUP_WORDS, &GROUP_FIRST, false));
            if adult {
                return true;
            }
        }
        contains_any(name, NAME_WORDS, &NAME_FIRST, true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hidden(name: &str, group: &str) -> bool {
        Filter::default().hides(&name.to_lowercase(), Some((0, &group.to_lowercase())))
    }

    #[test]
    fn adult_groups_and_names() {
        assert!(hidden("Canale 1", "XXX | ADULTS"));
        assert!(hidden("Canale 1", "XXX Amateur"));
        assert!(hidden("Canale 1", "For Adults 18+"));
        assert!(hidden("Canale 1", "Per adulti"));
        assert!(hidden("Canale 1", "Для взрослых"));
        assert!(hidden("Brazzers TV Europe", "Intrattenimento"));
        assert!(hidden("Playboy TV HD", "USA"));
        assert!(hidden("|EU| Dorcel XXX", "Europa"));
        assert!(hidden("IT: Film (18+)", "Cinema"));
        assert!(!hidden("Rai 1 HD", "Italia"));
        assert!(!hidden("Adult Swim", "Kids"));
        assert!(!hidden("Cartoni", "Adult Swim"));
        // Titoli comuni con parole "sospette": restano.
        assert!(!hidden("xXx (2002)", "Azione"));
        assert!(!hidden("MaXXXine (2024)", "Horror"));
        assert!(!hidden("The Deuce - La via del porno (2017) S01 E01", "Serie HBO Max"));
        assert!(!hidden("Playboy murders (2023) S01 E01", "Serie Discovery+"));
        assert!(!hidden("Pain Hustlers (2023)", "Crime"));
        assert!(!hidden("The Hustler (1961)", "Dramma"));
        assert!(!hidden("Sport 24", "Sport"));
    }

    #[test]
    fn group_verdict_is_cached() {
        let mut f = Filter::default();
        assert!(f.hides("canale", Some((3, "xxx"))));
        // Stesso gruppo: vale il giudizio già dato.
        assert!(f.hides("altro", Some((3, "testo diverso"))));
        assert!(!f.hides("altro", Some((1, "news"))));
        assert!(!f.hides("altro", None));
    }
}
