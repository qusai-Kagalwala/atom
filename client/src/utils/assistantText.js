// Chat words not in the FAQ file's ui_text (English, Arabic, Hindi, Gujarati).
// The FAQ file's own ui_text wins where both have a key.
export const CHAT_TEXT = {
  greeting: {
    en: 'Tell me what is wrong, or pick a topic below.',
    ar: 'أخبرني ما المشكلة، أو اختر موضوعًا من الأسفل.',
    hi: 'बताइए क्या समस्या है, या नीचे से कोई विषय चुनें।',
    gu: 'શું સમસ્યા છે તે જણાવો, અથવા નીચેથી કોઈ વિષય પસંદ કરો.',
  },
  placeholder: { en: 'Type your problem…', ar: 'اكتب مشكلتك…', hi: 'अपनी समस्या लिखें…', gu: 'તમારી સમસ્યા લખો…' },
  send: { en: 'Send', ar: 'إرسال', hi: 'भेजें', gu: 'મોકલો' },
  browse: { en: 'Browse topics', ar: 'تصفح المواضيع', hi: 'विषय देखें', gu: 'વિષયો જુઓ' },
  back: { en: 'Back', ar: 'رجوع', hi: 'वापस', gu: 'પાછા' },
  did_you_mean: { en: 'Did you mean one of these?', ar: 'هل تقصد أحد هذه؟', hi: 'क्या आपका मतलब इनमें से कोई है?', gu: 'શું તમારો મતલબ આમાંથી કોઈ છે?' },
  none_of_these: { en: 'None of these', ar: 'لا شيء من هذه', hi: 'इनमें से कोई नहीं', gu: 'આમાંથી કોઈ નહીં' },
  no_match: {
    en: 'I could not find an answer for that. Please raise a ticket and AVIT will help.',
    ar: 'لم أجد إجابة لذلك. يرجى فتح تذكرة دعم وسيساعدك فريق AVIT.',
    hi: 'मुझे इसका उत्तर नहीं मिला। कृपया टिकट दर्ज करें, AVIT आपकी मदद करेगा।',
    gu: 'મને આનો જવાબ મળ્યો નહીં. કૃપા કરીને ટિકિટ નોંધાવો, AVIT તમારી મદદ કરશે.',
  },
  start_over: { en: 'Start again', ar: 'ابدأ من جديد', hi: 'फिर से शुरू करें', gu: 'ફરી શરૂ કરો' },
  more_steps: { en: 'More detailed steps (English)', ar: 'خطوات أكثر تفصيلًا (بالإنجليزية)', hi: 'विस्तृत स्टेप्स (अंग्रेज़ी में)', gu: 'વધુ વિગતવાર સ્ટેપ્સ (અંગ્રેજીમાં)' },
  safety: { en: 'Before you start', ar: 'قبل أن تبدأ', hi: 'शुरू करने से पहले', gu: 'શરૂ કરતા પહેલા' },
  language: { en: 'Language', ar: 'اللغة', hi: 'भाषा', gu: 'ભાષા' },
  skip: {
    en: 'Skip — raise a ticket directly',
    ar: 'تخطَّ — افتح تذكرة مباشرة',
    hi: 'छोड़ें — सीधे टिकट दर्ज करें',
    gu: 'છોડો — સીધી ટિકિટ નોંધાવો',
  },
  thinking: { en: 'Looking…', ar: 'جارٍ البحث…', hi: 'खोज रहे हैं…', gu: 'શોધી રહ્યા છીએ…' },
  // Step C (each company's assistant; Tanzeem: requests first).
  no_guide: {
    en: 'There is no step-by-step guide for this yet. Raise a ticket and the right person is sent.',
    ar: 'لا يوجد دليل خطوة بخطوة لهذا بعد. افتح تذكرة وسيتم إرسال الشخص المناسب.',
    hi: 'इसके लिए अभी कोई स्टेप-बाय-स्टेप गाइड नहीं है। टिकट दर्ज करें, सही व्यक्ति भेजा जाएगा।',
    gu: 'આ માટે હજુ કોઈ સ્ટેપ-બાય-સ્ટેપ માર્ગદર્શિકા નથી. ટિકિટ નોંધાવો, યોગ્ય વ્યક્તિ મોકલવામાં આવશે.',
  },
  catalogue_found: { en: 'You can request these:', ar: 'يمكنك طلب هذه:', hi: 'आप इन्हें मंगवा सकते हैं:', gu: 'તમે આ મંગાવી શકો છો:' },
  request_button: { en: 'Request', ar: 'اطلب', hi: 'मंगवाएँ', gu: 'મંગાવો' },
  request_something: { en: 'Request something', ar: 'اطلب شيئًا', hi: 'कुछ मंगवाएँ', gu: 'કંઈક મંગાવો' },
  replace_button: {
    en: 'Something broken — raise a ticket',
    ar: 'شيء معطّل — افتح تذكرة',
    hi: 'कुछ खराब है — टिकट दर्ज करें',
    gu: 'કંઈક બગડ્યું છે — ટિકિટ નોંધાવો',
  },
  request_hint: {
    en: 'Need something? Request it. Is something broken or does it need replacing? Raise a ticket.',
    ar: 'تحتاج شيئًا؟ اطلبه. هل هناك شيء معطّل أو يحتاج إلى استبدال؟ افتح تذكرة.',
    hi: 'कुछ चाहिए? अनुरोध करें। कुछ खराब है या बदलना है? टिकट दर्ज करें।',
    gu: 'કંઈક જોઈએ છે? વિનંતી કરો. કંઈક બગડ્યું છે અથવા બદલવાની જરૂર છે? ટિકિટ નોંધાવો.',
  },
};

// Built-in fallbacks for the FAQ file's ui_text keys (used before the file is imported).
const UI_FALLBACK = {
  solved_prompt: 'Did this solve your problem?',
  yes: 'Yes',
  no: 'No',
  raise_ticket_button: 'Raise a ticket',
  glad_solved: 'Great! Your problem is solved.',
  try_steps_heading: 'Please try these steps:',
  choose_language: 'Choose your language',
};

// t(key): the FAQ file's ui_text first, then CHAT_TEXT, then English. The texts were written for AVIT;
// in another company "AVIT" is replaced by that company's name.
export function makeT(uiText, lang, companyName = null) {
  return (key) => {
    const text = uiText?.[key]?.[lang] || CHAT_TEXT[key]?.[lang] || uiText?.[key]?.en || CHAT_TEXT[key]?.en || UI_FALLBACK[key] || key;
    return companyName && companyName !== 'AVIT' ? text.replace(/\bAVIT\b/g, companyName) : text;
  };
}
