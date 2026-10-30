-- 021_company_guidelines.sql — "Before you start" safety tips per company (decided 30 Oct 2026). Idempotent.
--   They were shared by every company's assistant (AVIT's IT tips). Now each company has its own,
--   edited by its Admin (FAQs → Before you start): { en|ar|hi|gu: [tips] }. Empty = section hidden.
--   AVIT keeps the tips from its FAQ file; Siyanaat starts with maintenance safety tips; Tanzeem none.
ALTER TABLE service_units ADD COLUMN IF NOT EXISTS assistant_guidelines jsonb NOT NULL DEFAULT '{}';

UPDATE service_units SET assistant_guidelines = COALESCE((SELECT content->'guidelines' FROM assistant_settings WHERE id = 1), '{}')
 WHERE code = 'AVIT' AND assistant_guidelines = '{}';

UPDATE service_units SET assistant_guidelines = $json${
  "en": [
    "If you see sparks, smell burning or see smoke, move away and call for help at once.",
    "Do not touch exposed or loose wires. Switch off the MCB only if it is safe to do so.",
    "For a water leak, close the nearest valve if you can, and keep away from switches and sockets.",
    "Do not climb on furniture or try repairs yourself — raise a ticket and the right person is sent."
  ],
  "ar": [
    "إذا رأيت شررًا أو شممت رائحة احتراق أو رأيت دخانًا، فابتعد واطلب المساعدة فورًا.",
    "لا تلمس الأسلاك المكشوفة أو المرتخية. أطفئ القاطع الكهربائي فقط إذا كان ذلك آمنًا.",
    "عند تسرب الماء، أغلق أقرب صمام إن استطعت، وابتعد عن المفاتيح والمقابس.",
    "لا تتسلق الأثاث ولا تحاول الإصلاح بنفسك — افتح تذكرة وسيتم إرسال الشخص المناسب."
  ],
  "hi": [
    "चिंगारी दिखे, जलने की गंध आए या धुआँ दिखे तो तुरंत दूर हटें और मदद बुलाएँ।",
    "खुले या ढीले तारों को न छुएँ। MCB तभी बंद करें जब ऐसा करना सुरक्षित हो।",
    "पानी रिसाव हो तो हो सके तो पास का वाल्व बंद करें, और स्विच व सॉकेट से दूर रहें।",
    "फर्नीचर पर न चढ़ें और खुद मरम्मत न करें — टिकट दर्ज करें, सही व्यक्ति भेजा जाएगा।"
  ],
  "gu": [
    "તણખા દેખાય, બળવાની ગંધ આવે કે ધુમાડો દેખાય તો તરત દૂર ખસો અને મદદ બોલાવો.",
    "ખુલ્લા કે ઢીલા વાયરને અડશો નહીં. MCB ત્યારે જ બંધ કરો જ્યારે તે સુરક્ષિત હોય.",
    "પાણી લીક થાય તો શક્ય હોય તો નજીકનો વાલ્વ બંધ કરો, અને સ્વિચ અને સોકેટથી દૂર રહો.",
    "ફર્નિચર પર ચઢશો નહીં કે જાતે રિપેર કરશો નહીં — ટિકિટ નોંધાવો, યોગ્ય વ્યક્તિ મોકલવામાં આવશે."
  ]
}$json$::jsonb
 WHERE code = 'SIYANAAT' AND assistant_guidelines = '{}';
