// Библиотеки для .docx нужны только в момент генерации документа — грузим
// их тогда же, а не при старте приложения.
export const generateDocx = async (templateUrl: string, data: any, outputName: string) => {
  try {
    const [{ default: Docxtemplater }, { default: PizZip }, { saveAs }] = await Promise.all([
      import('docxtemplater'),
      import('pizzip'),
      import('file-saver'),
    ]);
    const response = await fetch(templateUrl);
    const content = await response.arrayBuffer();
    
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
    });
    
    doc.render(data);
    
    const blob = doc.getZip().generate({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    
    saveAs(blob, outputName);
  } catch (error) {
    console.error('Error generating document:', error);
    throw error;
  }
};
