// The signed-in user's own name, in the language they chose on their profile.
// Arabic is shown right-to-left in Amiri.
export default function UserName({ user, className = '' }) {
  const arabic = user.nameLanguage === 'ar' && user.nameArabic;
  if (arabic) {
    return (
      <span dir="rtl" lang="ar" className={`font-arabic ${className}`}>
        {user.nameArabic}
      </span>
    );
  }
  return <span className={className}>{user.displayName || user.name}</span>;
}
