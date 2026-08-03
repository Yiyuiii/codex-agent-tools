using System;
using System.Collections.Generic;

namespace CodexAgentTools.WindowsJobHelper.Tests
{
    internal static class TestAssert
    {
        internal static void Equal<T>(T expected, T actual)
        {
            if (!EqualityComparer<T>.Default.Equals(expected, actual))
            {
                throw new InvalidOperationException("assert_equal");
            }
        }

        internal static void True(bool value)
        {
            if (!value)
            {
                throw new InvalidOperationException("assert_true");
            }
        }

        internal static void Throws<T>(Action action) where T : Exception
        {
            try
            {
                action();
            }
            catch (T)
            {
                return;
            }

            throw new InvalidOperationException("assert_throws");
        }
    }
}
