using System;
using System.Collections.Generic;

namespace CodexAgentTools.HostAcceptance.Tests
{
    internal static class TestAssert
    {
        internal static void Equal<T>(T expected, T actual, string message)
        {
            if (!EqualityComparer<T>.Default.Equals(expected, actual))
            {
                throw new InvalidOperationException(message + " Expected: " + expected + "; actual: " + actual + ".");
            }
        }

        internal static void True(bool value, string message)
        {
            if (!value)
            {
                throw new InvalidOperationException(message);
            }
        }

        internal static void Throws<TException>(Action action, string message)
            where TException : Exception
        {
            try
            {
                action();
            }
            catch (TException)
            {
                return;
            }

            throw new InvalidOperationException(message);
        }
    }
}
