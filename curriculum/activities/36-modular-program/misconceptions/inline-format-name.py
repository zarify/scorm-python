def format_name(text):
    words = text.split()
    return " ".join(word.capitalize() for word in words)

print(format_name("ada lovelace grace hopper"))
