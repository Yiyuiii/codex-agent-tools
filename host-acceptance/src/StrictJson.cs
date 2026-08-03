using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace CodexAgentTools.HostAcceptance
{
    internal sealed class ProtocolException : Exception
    {
        internal ProtocolException() : base("Host acceptance protocol evidence is invalid.")
        {
        }
    }

    internal abstract class StrictJsonValue
    {
        internal StrictJsonObject RequireObject()
        {
            var value = this as StrictJsonObject;
            if (value == null)
            {
                throw new ProtocolException();
            }
            return value;
        }
    }

    internal sealed class StrictJsonObject : StrictJsonValue
    {
        private readonly Dictionary<string, StrictJsonValue> values;

        internal StrictJsonObject(Dictionary<string, StrictJsonValue> values)
        {
            this.values = values;
        }

        internal IEnumerable<KeyValuePair<string, StrictJsonValue>> Properties
        {
            get { return values; }
        }

        internal int Count
        {
            get { return values.Count; }
        }

        internal void RequireExactKeys(IEnumerable<string> expected)
        {
            var wanted = new HashSet<string>(expected, StringComparer.Ordinal);
            if (wanted.Count != values.Count)
            {
                throw new ProtocolException();
            }
            foreach (var key in values.Keys)
            {
                if (!wanted.Contains(key))
                {
                    throw new ProtocolException();
                }
            }
        }

        internal StrictJsonValue Require(string key)
        {
            StrictJsonValue value;
            if (!values.TryGetValue(key, out value))
            {
                throw new ProtocolException();
            }
            return value;
        }

        internal StrictJsonObject RequireObject(string key)
        {
            return Require(key).RequireObject();
        }

        internal string RequireString(string key)
        {
            var value = Require(key) as StrictJsonString;
            if (value == null)
            {
                throw new ProtocolException();
            }
            return value.Value;
        }

        internal StrictJsonNumber RequireNumber(string key)
        {
            var value = Require(key) as StrictJsonNumber;
            if (value == null)
            {
                throw new ProtocolException();
            }
            return value;
        }

        internal int RequireInt32(string key)
        {
            int parsed;
            var raw = RequireNumber(key).Raw;
            if (!int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out parsed))
            {
                throw new ProtocolException();
            }
            return parsed;
        }

        internal bool RequireBoolean(string key)
        {
            var value = Require(key) as StrictJsonBoolean;
            if (value == null)
            {
                throw new ProtocolException();
            }
            return value.Value;
        }
    }

    internal sealed class StrictJsonArray : StrictJsonValue
    {
        internal StrictJsonArray(List<StrictJsonValue> values)
        {
            Values = values.AsReadOnly();
        }

        internal IList<StrictJsonValue> Values { get; private set; }
    }

    internal sealed class StrictJsonString : StrictJsonValue
    {
        internal StrictJsonString(string value)
        {
            Value = value;
        }

        internal string Value { get; private set; }
    }

    internal sealed class StrictJsonNumber : StrictJsonValue
    {
        internal StrictJsonNumber(string raw)
        {
            Raw = raw;
        }

        internal string Raw { get; private set; }
    }

    internal sealed class StrictJsonBoolean : StrictJsonValue
    {
        internal StrictJsonBoolean(bool value)
        {
            Value = value;
        }

        internal bool Value { get; private set; }
    }

    internal sealed class StrictJsonNull : StrictJsonValue
    {
        internal static readonly StrictJsonNull Instance = new StrictJsonNull();

        private StrictJsonNull()
        {
        }
    }

    internal static class StrictJson
    {
        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);

        internal static StrictJsonValue ParseUtf8(byte[] bytes, bool forbidRawLineBreaks)
        {
            if (bytes == null || bytes.Length == 0)
            {
                throw new ProtocolException();
            }

            string text;
            try
            {
                text = StrictUtf8.GetString(bytes);
            }
            catch (DecoderFallbackException)
            {
                throw new ProtocolException();
            }
            if (text.Length == 0 || text[0] == '\ufeff')
            {
                throw new ProtocolException();
            }
            if (forbidRawLineBreaks && (text.IndexOf('\r') >= 0 || text.IndexOf('\n') >= 0))
            {
                throw new ProtocolException();
            }

            return new Parser(text).ParseDocument();
        }

        private sealed class Parser
        {
            private readonly string text;
            private int position;

            internal Parser(string text)
            {
                this.text = text;
            }

            internal StrictJsonValue ParseDocument()
            {
                SkipWhitespace();
                var value = ParseValue();
                SkipWhitespace();
                if (position != text.Length)
                {
                    throw new ProtocolException();
                }
                return value;
            }

            private StrictJsonValue ParseValue()
            {
                if (position >= text.Length)
                {
                    throw new ProtocolException();
                }

                switch (text[position])
                {
                    case '{': return ParseObject();
                    case '[': return ParseArray();
                    case '"': return new StrictJsonString(ParseString());
                    case 't': ParseLiteral("true"); return new StrictJsonBoolean(true);
                    case 'f': ParseLiteral("false"); return new StrictJsonBoolean(false);
                    case 'n': ParseLiteral("null"); return StrictJsonNull.Instance;
                    default:
                        if (text[position] == '-' || IsDigit(text[position]))
                        {
                            return ParseNumber();
                        }
                        throw new ProtocolException();
                }
            }

            private StrictJsonObject ParseObject()
            {
                position += 1;
                var values = new Dictionary<string, StrictJsonValue>(StringComparer.Ordinal);
                SkipWhitespace();
                if (Consume('}'))
                {
                    return new StrictJsonObject(values);
                }

                while (true)
                {
                    if (position >= text.Length || text[position] != '"')
                    {
                        throw new ProtocolException();
                    }
                    var key = ParseString();
                    if (values.ContainsKey(key))
                    {
                        throw new ProtocolException();
                    }
                    SkipWhitespace();
                    Require(':');
                    SkipWhitespace();
                    values.Add(key, ParseValue());
                    SkipWhitespace();
                    if (Consume('}'))
                    {
                        return new StrictJsonObject(values);
                    }
                    Require(',');
                    SkipWhitespace();
                }
            }

            private StrictJsonArray ParseArray()
            {
                position += 1;
                var values = new List<StrictJsonValue>();
                SkipWhitespace();
                if (Consume(']'))
                {
                    return new StrictJsonArray(values);
                }
                while (true)
                {
                    values.Add(ParseValue());
                    SkipWhitespace();
                    if (Consume(']'))
                    {
                        return new StrictJsonArray(values);
                    }
                    Require(',');
                    SkipWhitespace();
                }
            }

            private string ParseString()
            {
                Require('"');
                var builder = new StringBuilder();
                while (position < text.Length)
                {
                    var current = text[position++];
                    if (current == '"')
                    {
                        return builder.ToString();
                    }
                    if (current < 0x20 || char.IsSurrogate(current))
                    {
                        throw new ProtocolException();
                    }
                    if (current != '\\')
                    {
                        builder.Append(current);
                        continue;
                    }
                    if (position >= text.Length)
                    {
                        throw new ProtocolException();
                    }
                    switch (text[position++])
                    {
                        case '"': builder.Append('"'); break;
                        case '\\': builder.Append('\\'); break;
                        case '/': builder.Append('/'); break;
                        case 'b': builder.Append('\b'); break;
                        case 'f': builder.Append('\f'); break;
                        case 'n': builder.Append('\n'); break;
                        case 'r': builder.Append('\r'); break;
                        case 't': builder.Append('\t'); break;
                        case 'u': AppendUnicodeEscape(builder); break;
                        default: throw new ProtocolException();
                    }
                }
                throw new ProtocolException();
            }

            private void AppendUnicodeEscape(StringBuilder builder)
            {
                var first = ParseHexCodeUnit();
                if (first >= 0xd800 && first <= 0xdbff)
                {
                    if (position + 2 > text.Length || text[position] != '\\' || text[position + 1] != 'u')
                    {
                        throw new ProtocolException();
                    }
                    position += 2;
                    var second = ParseHexCodeUnit();
                    if (second < 0xdc00 || second > 0xdfff)
                    {
                        throw new ProtocolException();
                    }
                    builder.Append((char)first);
                    builder.Append((char)second);
                    return;
                }
                if (first >= 0xdc00 && first <= 0xdfff)
                {
                    throw new ProtocolException();
                }
                builder.Append((char)first);
            }

            private int ParseHexCodeUnit()
            {
                if (position + 4 > text.Length)
                {
                    throw new ProtocolException();
                }
                var value = 0;
                for (var index = 0; index < 4; index += 1)
                {
                    var digit = text[position++];
                    value = checked(value * 16 + HexValue(digit));
                }
                return value;
            }

            private StrictJsonNumber ParseNumber()
            {
                var start = position;
                Consume('-');
                if (Consume('0'))
                {
                    if (position < text.Length && IsDigit(text[position]))
                    {
                        throw new ProtocolException();
                    }
                }
                else
                {
                    RequireDigitOneToNine();
                    while (position < text.Length && IsDigit(text[position]))
                    {
                        position += 1;
                    }
                }

                if (Consume('.'))
                {
                    RequireDigit();
                    while (position < text.Length && IsDigit(text[position]))
                    {
                        position += 1;
                    }
                }
                if (position < text.Length && (text[position] == 'e' || text[position] == 'E'))
                {
                    position += 1;
                    if (position < text.Length && (text[position] == '+' || text[position] == '-'))
                    {
                        position += 1;
                    }
                    RequireDigit();
                    while (position < text.Length && IsDigit(text[position]))
                    {
                        position += 1;
                    }
                }
                return new StrictJsonNumber(text.Substring(start, position - start));
            }

            private void ParseLiteral(string literal)
            {
                if (position + literal.Length > text.Length || string.CompareOrdinal(text, position, literal, 0, literal.Length) != 0)
                {
                    throw new ProtocolException();
                }
                position += literal.Length;
            }

            private void SkipWhitespace()
            {
                while (position < text.Length)
                {
                    var value = text[position];
                    if (value != ' ' && value != '\t' && value != '\r' && value != '\n')
                    {
                        return;
                    }
                    position += 1;
                }
            }

            private bool Consume(char expected)
            {
                if (position < text.Length && text[position] == expected)
                {
                    position += 1;
                    return true;
                }
                return false;
            }

            private void Require(char expected)
            {
                if (!Consume(expected))
                {
                    throw new ProtocolException();
                }
            }

            private void RequireDigit()
            {
                if (position >= text.Length || !IsDigit(text[position]))
                {
                    throw new ProtocolException();
                }
                position += 1;
            }

            private void RequireDigitOneToNine()
            {
                if (position >= text.Length || text[position] < '1' || text[position] > '9')
                {
                    throw new ProtocolException();
                }
                position += 1;
            }

            private static bool IsDigit(char value)
            {
                return value >= '0' && value <= '9';
            }

            private static int HexValue(char value)
            {
                if (value >= '0' && value <= '9') return value - '0';
                if (value >= 'a' && value <= 'f') return value - 'a' + 10;
                if (value >= 'A' && value <= 'F') return value - 'A' + 10;
                throw new ProtocolException();
            }
        }
    }

    internal sealed class StrictJsonLineDecoder
    {
        private readonly int maximumFrameBytes;
        private readonly int maximumFrames;
        private readonly List<byte> buffer = new List<byte>();
        private int frameCount;

        internal StrictJsonLineDecoder() : this(ProtocolV1.MaximumFrameBytes, ProtocolV1.MaximumEventsPerConnection)
        {
        }

        internal StrictJsonLineDecoder(int maximumFrameBytes) : this(maximumFrameBytes, ProtocolV1.MaximumEventsPerConnection)
        {
        }

        internal StrictJsonLineDecoder(int maximumFrameBytes, int maximumFrames)
        {
            if (maximumFrameBytes < 2 || maximumFrames < 1)
            {
                throw new ArgumentOutOfRangeException();
            }
            this.maximumFrameBytes = maximumFrameBytes;
            this.maximumFrames = maximumFrames;
        }

        internal IList<StrictJsonValue> Append(byte[] bytes)
        {
            if (bytes == null)
            {
                throw new ArgumentNullException("bytes");
            }
            var values = new List<StrictJsonValue>();
            foreach (var value in bytes)
            {
                if (value == 0x0a)
                {
                    if (buffer.Count == 0 || checked(buffer.Count + 1) > maximumFrameBytes)
                    {
                        throw new ProtocolException();
                    }
                    frameCount = checked(frameCount + 1);
                    if (frameCount > maximumFrames)
                    {
                        throw new ProtocolException();
                    }
                    values.Add(StrictJson.ParseUtf8(buffer.ToArray(), true));
                    buffer.Clear();
                    continue;
                }
                buffer.Add(value);
                if (checked(buffer.Count + 1) > maximumFrameBytes)
                {
                    throw new ProtocolException();
                }
            }
            return values.AsReadOnly();
        }

        internal void Complete()
        {
            if (buffer.Count != 0)
            {
                throw new ProtocolException();
            }
        }
    }
}
