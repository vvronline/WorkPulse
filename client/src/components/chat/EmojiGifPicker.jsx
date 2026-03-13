import { useState, useEffect, useRef } from 'react';
import s from './EmojiGifPicker.module.css';

const EMOJI_CATEGORIES = [
    { label: '😀', name: 'Smileys', keywords: 'smile face happy laugh cry sad tears emotion mood', emojis: ['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','🥰','😘','😗','😙','😚','🙂','🤗','🤩','🤔','🤨','😐','😑','😶','🙄','😏','😣','😥','😮','🤐','😯','😪','😫','😴','😌','😛','😜','😝','🤤','😒','😓','😔','😕','🙃','🤑','😲','🤯','😬','🥵','🥶','😱','😨','😰','😢','😭','😤','😠','😡','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖'] },
    { label: '👋', name: 'Gestures', keywords: 'hand wave gesture thumb like dislike heart love ok clap prayer', emojis: ['👋','🤚','🖐️','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','💪','🦾','🖤','❤️','🧡','💛','💚','💙','💜','🤎','🖤','🤍','💯','💢','💥','💫','💦','💨','🕳️','💣','💬'] },
    { label: '🎉', name: 'Activities', keywords: 'party celebrate sport trophy medal ball game music art film camera activity', emojis: ['🎉','🎊','🎈','🎁','🏆','🥇','🥈','🥉','⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🪀','🏓','🏸','🥅','⛳','🪁','🏹','🎣','🤿','🥊','🎯','🎮','🕹️','🎲','🧩','♟️','🎭','🎨','🎼','🎹','🥁','🎷','🎺','🎸','🪕','🎻','🎬','📷'] },
    { label: '🍕', name: 'Food', keywords: 'eat drink food pizza burger coffee tea beer fruit meal snack dessert', emojis: ['🍕','🍔','🍟','🌭','🥪','🌮','🌯','🥙','🧆','🥚','🍳','🥘','🍲','🥣','🥗','🍿','🧈','🧂','🥫','🍱','🍘','🍙','🍚','🍛','🍜','🍝','🍠','🍢','🍣','🍤','🍥','🥮','🍡','🥟','🥠','🥡','🦀','🦞','🦐','🦑','🍦','🍧','🍨','🍩','🍪','🎂','🍰','🧁','🥧','🍫','🍬','🍭','☕','🍵','🥤','🍺','🍻','🥂','🍷'] },
    { label: '🌍', name: 'Nature', keywords: 'nature animal planet earth dog cat bird flower tree weather sun rain star fire water', emojis: ['🌍','🌎','🌏','🌐','🗺️','🧭','🏔️','⛰️','🌋','🗻','🏕️','🏖️','🏜️','🏝️','🏞️','🌅','🌄','🌠','🎇','🎆','🌇','🌆','🏙️','🌃','🌌','🌉','🌁','🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐦','🦅','🦆','🦉','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜','🦟','🌸','🌹','🌺','🌻','🌼','🌷','🌱','🌲','🌳','🌴','🌵','☀️','🌤️','⛅','🌥️','☁️','🌦️','🌧️','⛈️','🌩️','🌈','⭐','🌟','💫','✨','🔥','💧','🌊'] },
    { label: '💼', name: 'Objects', keywords: 'work office tool book phone computer lock key file folder document money', emojis: ['💼','📁','📂','📄','📋','📊','📈','📉','📌','📍','📎','🔗','🖇️','📐','📏','🗂️','💻','🖥️','🖨️','⌨️','🖱️','💾','💿','📀','📱','📲','☎️','📞','📟','📠','🔋','🔌','💡','🔦','🕯️','📔','📕','📖','📗','📘','📙','📚','📓','📒','📝','✏️','🖊️','🖋️','✒️','🔍','🔎','🔐','🔒','🔓','🔑'] },
];

export default function EmojiGifPicker({ onSelectEmoji, onClose }) {
    const [catIdx, setCatIdx] = useState(0);
    const [emojiSearch, setEmojiSearch] = useState('');
    const ref = useRef(null);

    // Close on click outside
    useEffect(() => {
        const handler = (e) => {
            if (ref.current && !ref.current.contains(e.target)) onClose();
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose]);

    const filteredEmojis = emojiSearch.trim()
        ? (() => {
            const q = emojiSearch.trim().toLowerCase();
            const matching = EMOJI_CATEGORIES.filter(c =>
                c.name.toLowerCase().includes(q) || c.keywords.toLowerCase().includes(q)
            );
            return matching.length > 0
                ? matching.flatMap(c => c.emojis)
                : EMOJI_CATEGORIES.flatMap(c => c.emojis);
          })()
        : EMOJI_CATEGORIES[catIdx].emojis;

    return (
        <div className={s.picker} ref={ref}>
            <input
                className={s.search}
                placeholder="Search emoji..."
                value={emojiSearch}
                onChange={e => setEmojiSearch(e.target.value)}
                autoFocus
            />
            {!emojiSearch && (
                <div className={s.catTabs}>
                    {EMOJI_CATEGORIES.map((c, i) => (
                        <button
                            key={c.name}
                            className={`${s.catTab} ${i === catIdx ? s.activeCat : ''}`}
                            onClick={() => setCatIdx(i)}
                            title={c.name}
                        >{c.label}</button>
                    ))}
                </div>
            )}
            <div className={s.emojiGrid}>
                {filteredEmojis.map((emoji, i) => (
                    <button
                        key={`${emoji}-${i}`}
                        className={s.emojiBtn}
                        onClick={() => { onSelectEmoji(emoji); onClose(); }}
                    >{emoji}</button>
                ))}
            </div>
        </div>
    );
}
