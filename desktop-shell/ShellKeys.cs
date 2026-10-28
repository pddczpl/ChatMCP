using ChatMCP.Native;
using System.Reflection;
using System.Text;

namespace ChatMCP.Desktop
{
    /// <summary>
    /// The release keys this shell trusts: the file DATGOLD-HUB/lib/release-keys.json as it was when the shell was built, embedded in the program (ChatMCP.csproj, property ReleaseKeysFile) so that nothing on disk
    /// after the build can add a key. The Hub reads the same file from the installation; the shell checks every update AGAIN with this list before it runs an installer. The file that ships has only a
    /// placeholder until the owner has made the release key, which trusts nothing: the shell then refuses to apply any update, and says so (no_trusted_key).
    /// </summary>
    internal static class ShellKeys
    {
        internal const string ResourceName = "ChatMCP.Desktop.release-keys.json";

        internal static ReleaseKeys Embedded()
        {
            using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName);
            if (stream == null) return ReleaseKeys.Parse(null);
            using var reader = new StreamReader(stream, new UTF8Encoding(false), detectEncodingFromByteOrderMarks: true);
            return ReleaseKeys.Parse(reader.ReadToEnd());
        }
    }
}
