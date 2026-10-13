try:
    n = int(input("Enter a number: "))
except ValueError:
    print("That was not a number. Try again.")

print("You entered:", n)
