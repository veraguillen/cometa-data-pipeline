from PyPDF2 import PdfReader, PdfWriter

# Configuración
input_pdf_path = "data/raw/simetrik.pdf"
output_pdf_path = "data/raw/simetrik_parte1.pdf"

def split_first_pages(input_path, output_path, num_pages=50):
    reader = PdfReader(input_path)
    writer = PdfWriter()

    # Vamos a tomar solo las primeras 50 páginas para estar seguros
    print(f"📄 El archivo original tiene {len(reader.pages)} páginas.")
    
    for i in range(num_pages):
        writer.add_page(reader.pages[i])

    with open(output_path, "wb") as output_pdf:
        writer.write(output_pdf)
    
    print(f"✅ ¡Listo! Se creó '{output_path}' con {num_pages} páginas.")

if __name__ == "__main__":
    split_first_pages(input_pdf_path, output_pdf_path)