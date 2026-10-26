using System.Globalization;

namespace ChatMCP.Native;

// A release version, shared by the shell (is this update newer than the one that runs?), the installer (is this setup newer than what is installed?) and the checks of a downloaded update.

/// <summary>A release version x.y.z, and nothing after it: what a release is called. Parts are numbers without a leading zero that JavaScript can hold exactly.</summary>
internal readonly record struct ReleaseVersion(long Major, long Minor, long Patch) : IComparable<ReleaseVersion>
{
    private const long MaxSafe = 9007199254740991; // Number.MAX_SAFE_INTEGER: what the Hub's isReleaseVersion takes
    private const int MaxLength = 64;

    /// <summary>False for anything that is not exactly three numbers with dots between them: a pre-release or build suffix, a leading zero, a sign, a space, a line break, a letter, a number too large.</summary>
    internal static bool TryParse(string? text, out ReleaseVersion version)
    {
        version = default;
        if (string.IsNullOrEmpty(text) || text.Length > MaxLength) return false;
        var parts = text.Split('.');
        if (parts.Length != 3) return false;
        var numbers = new long[3];
        for (var index = 0; index < 3; index++)
        {
            var part = parts[index];
            if (part.Length == 0 || (part.Length > 1 && part[0] == '0')) return false;
            foreach (var c in part) if (c < '0' || c > '9') return false;
            if (!long.TryParse(part, NumberStyles.None, CultureInfo.InvariantCulture, out numbers[index]) || numbers[index] > MaxSafe) return false;
        }
        version = new ReleaseVersion(numbers[0], numbers[1], numbers[2]);
        return true;
    }

    public int CompareTo(ReleaseVersion other) =>
        Major != other.Major ? Major.CompareTo(other.Major) : Minor != other.Minor ? Minor.CompareTo(other.Minor) : Patch.CompareTo(other.Patch);

    public override string ToString() => Major + "." + Minor + "." + Patch;
}
